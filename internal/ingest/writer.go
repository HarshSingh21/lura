package ingest

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
	"go.opentelemetry.io/otel/attribute"
)

// Writer is the Position Writer of HLD §5.3: a durable consumer that batches
// fixes into the positions table and advances each device's last known point
// under a monotonic guard.
//
// Batching is what makes the write path cheap (one INSERT for many fixes), and
// the monotonic guard is what makes an offline replay safe: a phone that
// reconnects and flushes an hour of queued fixes must fill in history without
// dragging the live marker back to where it was an hour ago.
type Writer struct {
	store store.Store
	b     bus.Bus
	log   *slog.Logger

	batchSize  int
	flushEvery time.Duration

	queue chan domain.Position
	sub   bus.Subscription
	done  chan struct{}
	wg    sync.WaitGroup
	once  sync.Once
}

// WriterOptions tunes batching.
type WriterOptions struct {
	BatchSize  int
	FlushEvery time.Duration
	QueueSize  int
}

// NewWriter returns an unstarted writer.
func NewWriter(st store.Store, b bus.Bus, log *slog.Logger, o WriterOptions) *Writer {
	if log == nil {
		log = slog.Default()
	}
	if o.BatchSize <= 0 {
		o.BatchSize = 200
	}
	if o.FlushEvery <= 0 {
		o.FlushEvery = 250 * time.Millisecond
	}
	if o.QueueSize <= 0 {
		o.QueueSize = 8192
	}
	return &Writer{
		store:      st,
		b:          b,
		log:        log,
		batchSize:  o.BatchSize,
		flushEvery: o.FlushEvery,
		queue:      make(chan domain.Position, o.QueueSize),
		done:       make(chan struct{}),
	}
}

// Start subscribes to the durable position stream and begins flushing.
func (w *Writer) Start(ctx context.Context) error {
	sub, err := w.b.SubscribePartitioned(bus.PosAll(), 1, bus.DeviceKey, func(m bus.Msg) {
		var pos domain.Position
		if err := json.Unmarshal(m.Data, &pos); err != nil {
			w.log.Error("writer: undecodable position", "subject", m.Subject, "error", err)
			return
		}
		select {
		case w.queue <- pos:
		case <-w.done:
		}
	})
	if err != nil {
		return err
	}
	w.sub = sub

	w.wg.Add(1)
	go w.run(ctx)
	return nil
}

// Stop drains the queue and stops the writer.
func (w *Writer) Stop() {
	w.once.Do(func() {
		if w.sub != nil {
			w.sub.Unsubscribe() // stop new work first, then drain what we have
		}
		close(w.done)
	})
	w.wg.Wait()
}

func (w *Writer) run(ctx context.Context) {
	defer w.wg.Done()
	ticker := time.NewTicker(w.flushEvery)
	defer ticker.Stop()

	batch := make([]domain.Position, 0, w.batchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		w.flush(ctx, batch)
		batch = batch[:0]
	}

	for {
		select {
		case pos := <-w.queue:
			batch = append(batch, pos)
			if len(batch) >= w.batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-w.done:
			for {
				select {
				case pos := <-w.queue:
					batch = append(batch, pos)
					if len(batch) >= w.batchSize {
						flush()
					}
				default:
					flush()
					return
				}
			}
		}
	}
}

func (w *Writer) flush(ctx context.Context, batch []domain.Position) {
	// Detached from the request context on purpose: a client disconnecting must
	// not abandon fixes that were already accepted and acked.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer cancel()

	ctx, span := obs.Start(ctx, "writer.flush")
	span.SetAttributes(attribute.Int("lura.batch_size", len(batch)))
	defer span.End()

	start := time.Now()
	written, err := w.store.InsertPositions(ctx, batch)
	metrics.StoreSeconds.ObserveSince(start, metrics.AttrOp.String("InsertPositions"))
	if err != nil {
		metrics.StoreErrors.Inc(metrics.AttrOp.String("InsertPositions"))
		w.log.ErrorContext(ctx, "writer: insert batch failed", "size", len(batch), "error", err)
		// The durable bus has already handed these to us; in Phase 2 this is where
		// a JetStream NAK belongs so the batch is redelivered. In Phase 1 we log
		// loudly rather than silently lose history.
		return
	}
	metrics.PositionsWritten.Add(int64(written))

	// One last_point update per device per batch: only the newest fix can win.
	newest := map[string]domain.Position{}
	for _, p := range batch {
		if cur, ok := newest[p.DeviceID]; !ok || p.RecvTS.After(cur.RecvTS) {
			newest[p.DeviceID] = p
		}
	}
	for dev, p := range newest {
		advanced, err := w.store.TouchLastPoint(ctx, dev, p.Point, p.RecvTS, p.SpeedMPS, p.Battery)
		if err != nil {
			metrics.StoreErrors.Inc(metrics.AttrOp.String("TouchLastPoint"))
			w.log.ErrorContext(ctx, "writer: last_point update failed", "device", dev, "error", err)
			continue
		}
		if !advanced {
			// Expected whenever an offline device replays its queue.
			metrics.PositionsStale.Inc(metrics.AttrDevice.String(dev))
			w.log.DebugContext(ctx, "writer: stale fix did not advance last_point",
				"device", dev, "recvTs", p.RecvTS)
		}
	}
}
