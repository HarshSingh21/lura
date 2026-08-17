// Package metrics declares Lura's application metrics as OpenTelemetry
// instruments.
//
// HLD §12 names the golden signals: ingest rate and ack latency, consumer lag,
// geofence eval latency, dropped-stale-ping count, trigger → delivery latency,
// WebSocket connections and drop rate, DB latency, push success per channel.
// Each one is declared here exactly once and used from the package that owns it.
//
// Instruments are created against the *global* meter provider at package init.
// That is safe and intentional: OpenTelemetry's global provider delegates, so
// instruments created before obs.Setup installs the SDK start recording as soon
// as it does, and recording with no SDK installed is a no-op rather than a nil
// dereference. The upshot is that library code never has to thread a MeterProvider
// around, and tests need no observability setup at all.
package metrics

import (
	"context"
	"sync"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"
)

// ScopeName is the instrumentation scope every Lura metric is reported under.
const ScopeName = "github.com/HarshSingh21/locnot"

var meter = otel.Meter(ScopeName)

// bg is used for instrument recording: metric recording is not cancellable and
// carrying a request context adds nothing but exemplar noise here.
var bg = context.Background()

// Counter is a monotonic counter.
type Counter struct{ c metric.Int64Counter }

// Inc adds one, with optional attributes.
func (c Counter) Inc(attrs ...attribute.KeyValue) { c.Add(1, attrs...) }

// Add adds n, with optional attributes.
func (c Counter) Add(n int64, attrs ...attribute.KeyValue) {
	if c.c == nil {
		return
	}
	if len(attrs) == 0 {
		c.c.Add(bg, n)
		return
	}
	c.c.Add(bg, n, metric.WithAttributes(attrs...))
}

// Histogram records a distribution of seconds.
type Histogram struct{ h metric.Float64Histogram }

// Observe records one sample in seconds.
func (h Histogram) Observe(seconds float64, attrs ...attribute.KeyValue) {
	if h.h == nil {
		return
	}
	if len(attrs) == 0 {
		h.h.Record(bg, seconds)
		return
	}
	h.h.Record(bg, seconds, metric.WithAttributes(attrs...))
}

// ObserveSince records the time elapsed since start.
func (h Histogram) ObserveSince(start time.Time, attrs ...attribute.KeyValue) {
	h.Observe(time.Since(start).Seconds(), attrs...)
}

// Gauge is an up-down value. It keeps its own running total so callers can say
// Add(+1)/Add(-1) (connections opening and closing) as well as Set.
type Gauge struct {
	g  metric.Float64Gauge
	mu sync.Mutex
	v  float64
}

// Set replaces the value.
func (g *Gauge) Set(v float64, attrs ...attribute.KeyValue) {
	g.mu.Lock()
	g.v = v
	g.mu.Unlock()
	g.record(v, attrs...)
}

// Add applies a delta to the value.
func (g *Gauge) Add(delta float64, attrs ...attribute.KeyValue) {
	g.mu.Lock()
	g.v += delta
	v := g.v
	g.mu.Unlock()
	g.record(v, attrs...)
}

// Value returns the current value.
func (g *Gauge) Value() float64 {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.v
}

func (g *Gauge) record(v float64, attrs ...attribute.KeyValue) {
	if g.g == nil {
		return
	}
	if len(attrs) == 0 {
		g.g.Record(bg, v)
		return
	}
	g.g.Record(bg, v, metric.WithAttributes(attrs...))
}

func newCounter(name, desc, unit string) Counter {
	c, err := meter.Int64Counter(name, metric.WithDescription(desc), metric.WithUnit(unit))
	if err != nil {
		// Only returned for an invalid instrument name, which is a programming
		// error caught the first time the process starts.
		panic("metrics: " + name + ": " + err.Error())
	}
	return Counter{c: c}
}

func newHistogram(name, desc string, buckets ...float64) Histogram {
	opts := []metric.Float64HistogramOption{
		metric.WithDescription(desc),
		metric.WithUnit("s"),
	}
	if len(buckets) > 0 {
		opts = append(opts, metric.WithExplicitBucketBoundaries(buckets...))
	}
	h, err := meter.Float64Histogram(name, opts...)
	if err != nil {
		panic("metrics: " + name + ": " + err.Error())
	}
	return Histogram{h: h}
}

func newGauge(name, desc, unit string) *Gauge {
	g, err := meter.Float64Gauge(name, metric.WithDescription(desc), metric.WithUnit(unit))
	if err != nil {
		panic("metrics: " + name + ": " + err.Error())
	}
	return &Gauge{g: g}
}

// latencyBuckets spans a sub-millisecond ack (HLD NFR: /pub p99 < 50 ms) through
// a multi-second push delivery, so one bucket set serves every latency metric.
var latencyBuckets = []float64{0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10}

// Attribute keys used across instruments. Kept as constants so a dashboard
// query never breaks on a typo.
const (
	AttrDevice  = attribute.Key("lura.device_id")
	AttrTrigger = attribute.Key("lura.trigger")
	AttrChannel = attribute.Key("lura.channel")
	AttrOutcome = attribute.Key("lura.outcome")
	AttrRoute   = attribute.Key("http.route")
	AttrMethod  = attribute.Key("http.request.method")
	AttrStatus  = attribute.Key("http.response.status_code")
	AttrStore   = attribute.Key("lura.store")
	AttrOp      = attribute.Key("lura.operation")
	AttrSubject = attribute.Key("lura.subject")
)

// The golden signals from HLD §12.
var (
	// Ingest (§5.2)
	IngestAccepted   = newCounter("lura.ingest.accepted", "Position fixes accepted by /pub", "{fix}")
	IngestRejected   = newCounter("lura.ingest.rejected", "Position fixes rejected (bad payload, auth, rate limit)", "{fix}")
	IngestAckSeconds = newHistogram("lura.ingest.ack.duration", "Server-side /pub ack latency (NFR: p99 < 50ms)", latencyBuckets...)

	// Position writer (§5.3)
	PositionsWritten = newCounter("lura.positions.written", "Position rows persisted", "{row}")
	PositionsStale   = newCounter("lura.positions.stale", "Fixes rejected by the monotonic last_point guard", "{fix}")

	// Geofence engine (§5.4)
	GeoEvalSeconds  = newHistogram("lura.geofence.eval.duration", "Geofence evaluation latency per fix", latencyBuckets...)
	GeoDroppedStale = newCounter("lura.geofence.dropped_stale", "Fixes skipped by the freshness gate", "{fix}")
	GeoEventsFired  = newCounter("lura.geofence.events", "Geofence events published", "{event}")
	GeoCooloffSuppr = newCounter("lura.geofence.cooloff_suppressed", "Events suppressed by the cool-off gate", "{event}")
	GeoDebounceHold = newCounter("lura.geofence.debounce_held", "Arrive candidates held by the fly-by filter", "{event}")
	GeoDwellArmed   = newCounter("lura.geofence.dwell_armed", "Dwell timers armed", "{timer}")

	// Notification (§5.6)
	NotifyDelivered = newCounter("lura.notify.delivered", "Reminder deliveries that succeeded", "{message}")
	NotifyFailed    = newCounter("lura.notify.failed", "Reminder deliveries that failed on every channel", "{message}")
	NotifyQuiet     = newCounter("lura.notify.quiet_hours", "Reminders held back by quiet hours", "{message}")
	NotifySeconds   = newHistogram("lura.notify.delivery.duration", "Geo event → delivered latency (NFR: p95 < 2s)", latencyBuckets...)

	// Gateway / fan-out (§5.1)
	WSConnections = newGauge("lura.ws.connections", "Open WebSocket connections", "{connection}")
	WSDropped     = newCounter("lura.ws.dropped_frames", "Frames dropped by drop-to-latest backpressure", "{frame}")
	WSSent        = newCounter("lura.ws.frames_sent", "Frames written to WebSocket clients", "{frame}")

	// Bus (§4)
	BusPublished  = newCounter("lura.bus.published", "Messages published on the bus", "{message}")
	BusDelivered  = newCounter("lura.bus.delivered", "Messages delivered to bus subscribers", "{message}")
	BusDropped    = newCounter("lura.bus.dropped", "Messages dropped by a full core-bus subscriber queue", "{message}")
	BusQueueDepth = newGauge("lura.bus.queue_depth", "Queued messages across durable bus partitions (consumer lag)", "{message}")

	// Storage
	StoreSeconds = newHistogram("lura.store.operation.duration", "Store operation duration", latencyBuckets...)
	StoreErrors  = newCounter("lura.store.errors", "Store operations that returned an error", "{operation}")

	// HTTP
	HTTPRequests = newCounter("lura.http.requests", "HTTP requests served", "{request}")
	HTTPErrors   = newCounter("lura.http.errors", "HTTP responses with status >= 500", "{response}")
	HTTPSeconds  = newHistogram("lura.http.server.duration", "HTTP request duration", latencyBuckets...)

	// Observability plumbing itself
	LogsShipped = newCounter("lura.logs.shipped", "Log records shipped to OpenSearch", "{record}")
	LogsDropped = newCounter("lura.logs.dropped", "Log records dropped by a full shipper queue", "{record}")
)
