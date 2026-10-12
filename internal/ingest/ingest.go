// Package ingest is the write path for location fixes.
//
// HLD §5.2 and §9 pin the contract: validate, rate-limit, stamp a
// high-resolution server-receive timestamp, publish, ack. Nothing slow happens
// inline — persistence, geofence evaluation and fan-out all hang off the bus —
// which is what keeps the p99 ack under the 50 ms NFR.
//
// The idempotency key is (device_id, recv_ts µs) plus an optional client
// sequence number, deliberately *not* OwnTracks' `tst`: that field has
// one-second resolution and collides for two genuine fixes in the same second
// (HLD §5.2, "Idempotency (fixed)").
package ingest

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/ratelimit"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// ErrRateLimited is returned when a device exceeds its fix budget.
var ErrRateLimited = errors.New("rate limited")

// Outcome says what Accept did with a valid fix.
type Outcome int

const (
	// Fresh is the newest fix for its device: history, live map and geofences.
	Fresh Outcome = iota
	// Late is older, by the device's clock, than a fix already accepted for the
	// device. It goes to history only (Position.Late).
	Late
	// Duplicate is a byte-for-byte resend of the device's newest fix (same
	// device time, point and sequence). Nothing is published; the ack repeats.
	Duplicate
)

// Payload is an OwnTracks `_type:location` message, extended with two optional
// Lura fields.
//
// OwnTracks compatibility matters because it means any existing OwnTracks
// installation can point at Lura without new client software (HLD §2.1).
type Payload struct {
	Type string `json:"_type"`

	Lat  float64  `json:"lat"`
	Lon  float64  `json:"lon"`
	TST  int64    `json:"tst"`  // device clock, epoch seconds
	Acc  *float64 `json:"acc"`  // accuracy, metres
	Vel  *float64 `json:"vel"`  // velocity, km/h (OwnTracks unit)
	Alt  *float64 `json:"alt"`  // altitude, metres
	Cog  *float64 `json:"cog"`  // course over ground, degrees
	Batt *float64 `json:"batt"` // battery percentage
	TID  string   `json:"tid"`  // tracker id
	Conn string   `json:"conn"` // w=wifi, m=mobile, o=offline

	// Lura extensions, both optional:
	SpeedMPS *float64 `json:"speedMps"` // exact m/s, avoids the km/h round-trip
	Seq      int64    `json:"seq"`      // client sequence number for dedupe
}

// Validate rejects payloads that cannot be a location fix. Being strict here is
// cheap; being lax means garbage in the history and phantom geofence events.
func (p Payload) Validate() error {
	if p.Type != "" && p.Type != "location" {
		return fmt.Errorf("unsupported _type %q: %w", p.Type, domain.ErrInvalid)
	}
	if !geo.Valid(p.Lat, p.Lon) {
		return fmt.Errorf("lat/lon out of range: %w", domain.ErrInvalid)
	}
	if p.Lat == 0 && p.Lon == 0 {
		// Null Island: almost always an uninitialised GPS reading, never a real
		// user. Dropping it keeps the history and the map honest.
		return fmt.Errorf("null coordinates: %w", domain.ErrInvalid)
	}
	if p.Acc != nil && (*p.Acc < 0 || *p.Acc > 100_000) {
		return fmt.Errorf("implausible accuracy %.1f: %w", *p.Acc, domain.ErrInvalid)
	}
	if p.Batt != nil && (*p.Batt < 0 || *p.Batt > 100) {
		return fmt.Errorf("battery out of range: %w", domain.ErrInvalid)
	}
	return nil
}

// Service accepts fixes and publishes them.
type Service struct {
	bus     bus.Bus
	log     *slog.Logger
	limiter *ratelimit.Limiter
	now     func() time.Time

	// newest is the newest fix accepted per device (*deviceOrder), by device
	// clock. It is what tells a phone's queued fix — sent after a newer one
	// over a flaky network — from news. In memory on purpose: after a restart
	// the first fix simply wins, which is what a fresh map would show anyway.
	newest sync.Map
}

// deviceOrder serialises one device's fixes: the decision "is this newer?"
// and the publish that follows it happen under one lock, so two concurrent
// requests from the same phone cannot reach the bus in the wrong order.
type deviceOrder struct {
	mu    sync.Mutex
	ts    time.Time
	point domain.Point
	seq   int64
	seen  bool

	// clock is how far the device's clock runs behind the server's.
	clock clockSkew
}

// clockSkew estimates a device's clock offset (receive time − device time)
// from its recent fixes. A fix sent the moment it was taken has the smallest
// offset — transit only — so the minimum over a sliding window is the clock
// difference; a queued fix shows up as an offset well above it. The window
// lets the estimate follow a clock that was corrected (NTP, a laptop waking
// from sleep with a lagging timer) within skewWindow.
type clockSkew struct {
	samples []skewSample
}

type skewSample struct {
	recv   time.Time
	offset time.Duration
}

const (
	skewWindow  = 10 * time.Minute
	skewSamples = 64
)

// observe records a fix and returns the device's current offset estimate.
func (c *clockSkew) observe(recv time.Time, offset time.Duration) time.Duration {
	keep := c.samples[:0]
	for _, s := range c.samples {
		if recv.Sub(s.recv) <= skewWindow {
			keep = append(keep, s)
		}
	}
	c.samples = append(keep, skewSample{recv: recv, offset: offset})
	if len(c.samples) > skewSamples {
		c.samples = c.samples[len(c.samples)-skewSamples:]
	}
	low := c.samples[0].offset
	for _, s := range c.samples[1:] {
		if s.offset < low {
			low = s.offset
		}
	}
	return low
}

// New returns an ingest service.
func New(b bus.Bus, log *slog.Logger, ratePerMin, burst int) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		bus:     b,
		log:     log,
		limiter: ratelimit.New(ratePerMin, burst),
		now:     time.Now,
	}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Accept validates and publishes one fix for an authenticated device. It returns
// the stored position so the caller can echo it back.
//
// Publish order is deliberate: durable first, then live. If the process dies
// between the two, we lose a live frame (the next fix repaints the map in
// seconds) rather than a durable record (which would lose a reminder or a
// history row).
func (s *Service) Accept(ctx context.Context, dev domain.Device, p Payload) (domain.Position, error) {
	start := s.now()
	ctx, span := obs.Start(ctx, "ingest.accept", trace.WithAttributes(
		attribute.String("lura.device_id", dev.ID),
		attribute.String("lura.user_id", dev.UserID),
	))
	defer span.End()

	if err := p.Validate(); err != nil {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("invalid"))
		span.SetStatus(codes.Error, "invalid payload")
		return domain.Position{}, err
	}

	if !s.limiter.Allow(dev.ID) {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("rate_limited"))
		span.SetStatus(codes.Error, "rate limited")
		return domain.Position{}, fmt.Errorf("device %s: %w", dev.ID, ErrRateLimited)
	}

	pos := s.toPosition(dev, p, start)

	v, _ := s.newest.LoadOrStore(dev.ID, &deviceOrder{})
	order := v.(*deviceOrder)
	order.mu.Lock()
	defer order.mu.Unlock()
	// When the device was there, on the server's clock. The first fix a
	// device ever sends can only be taken at its word (there is nothing yet
	// to tell a slow clock from a queued fix), which is why the estimate is
	// learnt from live traffic before it is needed.
	if p.TST > 0 {
		offset := pos.RecvTS.Sub(pos.DeviceTS)
		skew := order.clock.observe(pos.RecvTS, offset)
		pos.FixTS = pos.DeviceTS.Add(skew)
		if pos.FixTS.After(pos.RecvTS) {
			pos.FixTS = pos.RecvTS
		}
	}
	switch classify(order, p, pos) {
	case Duplicate:
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("duplicate"))
		span.SetAttributes(attribute.Bool("lura.duplicate", true))
		return pos, nil
	case Late:
		pos.Late = true
		span.SetAttributes(attribute.Bool("lura.late", true))
	default:
		if p.TST > 0 {
			order.ts, order.point, order.seq, order.seen = pos.DeviceTS, pos.Point, pos.Seq, true
		}
	}

	// Durable path: the position writer and the geofence engine consume this,
	// partitioned by device so one device's fixes stay ordered (HLD §5.4).
	if err := bus.PublishDurableJSON(s.bus, bus.PosSubject(dev.UserID, dev.ID), pos); err != nil {
		metrics.IngestRejected.Inc(metrics.AttrOutcome.String("bus"))
		span.SetStatus(codes.Error, "durable publish failed")
		return domain.Position{}, fmt.Errorf("ingest: durable publish: %w", err)
	}

	// Live path: at-most-once fan-out to whichever Gateway subscribers exist.
	// A late fix is not news: drawing it would step the marker backwards.
	if pos.Late {
		metrics.IngestAccepted.Inc()
		metrics.IngestAckSeconds.ObserveSince(start)
		return pos, nil
	}
	if err := bus.PublishJSON(s.bus, bus.PosSubject(dev.UserID, dev.ID), pos); err != nil {
		// Not fatal: history and reminders are already guaranteed by the durable
		// publish above, and the next fix will repaint the live map.
		s.log.WarnContext(ctx, "ingest: live publish failed", "device", dev.ID, "error", err)
	}

	metrics.IngestAccepted.Inc()
	metrics.IngestAckSeconds.ObserveSince(start)
	span.SetAttributes(attribute.Float64("lura.speed_mps", pos.SpeedMPS))
	return pos, nil
}

// classify orders a fix against the newest one accepted for its device.
//
// Only a fix that carries its own time (OwnTracks tst) can be ordered: one
// without is stamped with the receive time and is always the newest. Two fixes
// in the same second are both news unless they are the same fix — tst has
// one-second resolution, and a phone moving at 30 m/s covers a fence in it.
func classify(order *deviceOrder, p Payload, pos domain.Position) Outcome {
	if p.TST <= 0 || !order.seen {
		return Fresh
	}
	switch {
	case pos.DeviceTS.Before(order.ts):
		return Late
	case pos.DeviceTS.Equal(order.ts) && pos.Point == order.point && pos.Seq == order.seq:
		return Duplicate
	default:
		return Fresh
	}
}

// RetryAfter reports how long a rate-limited device should wait.
func (s *Service) RetryAfter(deviceID string) time.Duration { return s.limiter.Retry(deviceID) }

func (s *Service) toPosition(dev domain.Device, p Payload, recv time.Time) domain.Position {
	pos := domain.Position{
		DeviceID: dev.ID,
		UserID:   dev.UserID,
		RecvTS:   recv.UTC(),
		FixTS:    recv.UTC(),
		Point:    domain.Point{Lat: p.Lat, Lon: p.Lon},
		Seq:      p.Seq,
	}

	// Device clock is data, not truth: a phone with a wrong clock must not be
	// able to reorder history or defeat the freshness gate.
	if p.TST > 0 {
		pos.DeviceTS = time.Unix(p.TST, 0).UTC()
	} else {
		pos.DeviceTS = pos.RecvTS
	}

	switch {
	case p.SpeedMPS != nil:
		pos.SpeedMPS = *p.SpeedMPS
	case p.Vel != nil:
		pos.SpeedMPS = *p.Vel * 1000 / 3600 // OwnTracks reports km/h
	}
	if pos.SpeedMPS < 0 {
		pos.SpeedMPS = 0
	}
	if p.Acc != nil {
		pos.AccuracyM = *p.Acc
	}
	if p.Alt != nil {
		pos.AltitudeM = *p.Alt
	}
	if p.Cog != nil {
		pos.HeadingD = *p.Cog
	}
	if p.Batt != nil {
		pos.Battery = int(*p.Batt)
	}
	return pos
}
