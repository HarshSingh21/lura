// Package obs wires Lura's observability: OpenTelemetry traces, metrics and
// logs, a Prometheus scrape endpoint, and log shipping to OpenSearch.
//
// HLD §12 asks for OpenTelemetry across all Go services with the golden signals
// exposed, and §11 makes "no outbound calls in airgap mode" a product-defining
// invariant. Both are honoured here in one place:
//
//   - One resource (service.name/version/instance) describes the process to every
//     backend, so a trace, a metric and a log line join up.
//   - Traces and metrics and logs all leave over OTLP/HTTP to a collector, which
//     is the only component that needs to know where the backends live.
//   - Logs additionally go to stdout (always) and to OpenSearch (optionally,
//     directly — useful when there is no collector in front).
//   - Airgap mode disables every egress exporter and keeps stdout logging and the
//     inbound /metrics endpoint. Nothing leaves the box, and the operator still
//     has signals.
//
// Everything here is Apache-2.0 licensed upstream (OpenTelemetry, OpenSearch,
// Prometheus client), in line with the all-open-source constraint.
package obs

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"go.opentelemetry.io/contrib/bridges/otelslog"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploghttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	promexp "go.opentelemetry.io/otel/exporters/prometheus"
	"go.opentelemetry.io/otel/propagation"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.43.0"
	"go.opentelemetry.io/otel/trace"
)

// Options configures observability setup.
type Options struct {
	ServiceName    string
	ServiceVersion string
	Environment    string
	InstanceID     string

	// OTLPEndpoint is a base URL such as http://localhost:4318. Empty falls back
	// to the OTEL_EXPORTER_OTLP_ENDPOINT environment variable, and if that is
	// also empty the OTLP exporters are simply not installed.
	OTLPEndpoint string
	OTLPInsecure bool
	OTLPHeaders  map[string]string

	EnableTraces     bool
	EnableMetrics    bool
	EnableOTLPLogs   bool
	TraceSampleRatio float64

	// MetricInterval is how often metrics are pushed over OTLP.
	MetricInterval time.Duration

	// Prometheus exposes a /metrics endpoint fed by the same instruments.
	EnablePrometheus bool

	// OpenSearch log shipping. Empty URL disables it.
	OpenSearchURL      string
	OpenSearchIndex    string
	OpenSearchUser     string
	OpenSearchPassword string
	OpenSearchInsecure bool

	// Airgap disables every network exporter regardless of the settings above.
	Airgap bool

	LogLevel  string // debug | info | warn | error
	LogFormat string // text | json
	LogWriter *os.File
}

// Provider owns the installed SDK and the shutdown funcs that flush it.
type Provider struct {
	Logger      *slog.Logger
	Tracer      trace.Tracer
	PromHandler http.Handler

	// Enabled reports which pipelines are live, for /healthz.
	Enabled map[string]bool

	shutdown []func(context.Context) error
	shipper  *OpenSearchShipper
}

// Setup installs the OpenTelemetry SDK, builds the process logger and returns a
// Provider. It never fails hard on an exporter it cannot reach: a metrics
// backend being down must not stop a location tracker from tracking locations,
// so exporter construction errors are logged and that pipeline is skipped.
func Setup(ctx context.Context, o Options) (*Provider, error) {
	o = o.withDefaults()

	// The schema URL must match resource.Default()'s, or Merge refuses to combine
	// them; keeping the semconv import version in step with the SDK is the fix.
	res, err := resource.Merge(resource.Default(), resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceNameKey.String(o.ServiceName),
		semconv.ServiceVersionKey.String(o.ServiceVersion),
		semconv.ServiceInstanceIDKey.String(o.InstanceID),
		semconv.DeploymentEnvironmentNameKey.String(o.Environment),
	))
	if err != nil {
		return nil, fmt.Errorf("obs: build resource: %w", err)
	}

	p := &Provider{Enabled: map[string]bool{}}

	// Bootstrap logger: used to report problems setting up the real one.
	boot := slog.New(newStdoutHandler(o))

	otlpBase := o.OTLPEndpoint
	if otlpBase == "" {
		otlpBase = os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	}
	egress := !o.Airgap && otlpBase != ""
	if o.Airgap {
		boot.Info("airgap mode: observability egress disabled, stdout logs and /metrics only")
	}

	// ---- propagation: W3C trace context + baggage, so a trace survives the
	// hop from the app to any future extracted service.
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{}, propagation.Baggage{},
	))

	// ---- traces
	if egress && o.EnableTraces {
		exp, err := otlptracehttp.New(ctx, traceOpts(otlpBase, o)...)
		if err != nil {
			boot.Warn("obs: OTLP trace exporter unavailable, traces disabled", "error", err)
		} else {
			tp := sdktrace.NewTracerProvider(
				sdktrace.WithResource(res),
				sdktrace.WithBatcher(exp, sdktrace.WithBatchTimeout(5*time.Second)),
				sdktrace.WithSampler(sdktrace.ParentBased(sdktrace.TraceIDRatioBased(o.TraceSampleRatio))),
			)
			otel.SetTracerProvider(tp)
			p.shutdown = append(p.shutdown, tp.Shutdown)
			p.Enabled["traces"] = true
		}
	}
	p.Tracer = otel.Tracer(TracerName)

	// ---- metrics: OTLP push and/or Prometheus pull, both fed by one provider
	var readers []sdkmetric.Option
	if egress && o.EnableMetrics {
		exp, err := otlpmetrichttp.New(ctx, metricOpts(otlpBase, o)...)
		if err != nil {
			boot.Warn("obs: OTLP metric exporter unavailable, OTLP metrics disabled", "error", err)
		} else {
			readers = append(readers, sdkmetric.WithReader(
				sdkmetric.NewPeriodicReader(exp, sdkmetric.WithInterval(o.MetricInterval)),
			))
			p.Enabled["metrics_otlp"] = true
		}
	}
	if o.EnablePrometheus {
		reg := prometheus.NewRegistry()
		reg.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
		// No WithNamespace: the instrument names already start with "lura.", and a
		// namespace would export them as lura_lura_….
		exp, err := promexp.New(promexp.WithRegisterer(reg))
		if err != nil {
			boot.Warn("obs: prometheus exporter unavailable, /metrics disabled", "error", err)
		} else {
			readers = append(readers, sdkmetric.WithReader(exp))
			p.PromHandler = promhttp.HandlerFor(reg, promhttp.HandlerOpts{
				ErrorHandling: promhttp.ContinueOnError,
			})
			p.Enabled["metrics_prometheus"] = true
		}
	}
	if len(readers) > 0 {
		opts := append([]sdkmetric.Option{sdkmetric.WithResource(res)}, readers...)
		mp := sdkmetric.NewMeterProvider(opts...)
		otel.SetMeterProvider(mp)
		p.shutdown = append(p.shutdown, mp.Shutdown)
	}

	// ---- logs: stdout always; OTLP and OpenSearch when allowed
	handlers := []slog.Handler{newStdoutHandler(o)}

	if egress && o.EnableOTLPLogs {
		exp, err := otlploghttp.New(ctx, logOpts(otlpBase, o)...)
		if err != nil {
			boot.Warn("obs: OTLP log exporter unavailable, OTLP logs disabled", "error", err)
		} else {
			lp := sdklog.NewLoggerProvider(
				sdklog.WithResource(res),
				sdklog.WithProcessor(sdklog.NewBatchProcessor(exp)),
			)
			p.shutdown = append(p.shutdown, lp.Shutdown)
			handlers = append(handlers, otelslog.NewHandler(ScopeName,
				otelslog.WithLoggerProvider(lp),
				otelslog.WithSource(true),
			))
			p.Enabled["logs_otlp"] = true
		}
	}

	if !o.Airgap && o.OpenSearchURL != "" {
		sh, err := NewOpenSearchShipper(OpenSearchConfig{
			URL:            o.OpenSearchURL,
			Index:          o.OpenSearchIndex,
			Username:       o.OpenSearchUser,
			Password:       o.OpenSearchPassword,
			InsecureTLS:    o.OpenSearchInsecure,
			ServiceName:    o.ServiceName,
			ServiceVersion: o.ServiceVersion,
			Environment:    o.Environment,
			InstanceID:     o.InstanceID,
			Level:          parseLevel(o.LogLevel),
			OnError:        func(err error) { boot.Warn("obs: opensearch shipper", "error", err) },
		})
		if err != nil {
			boot.Warn("obs: opensearch log shipping unavailable", "error", err)
		} else {
			handlers = append(handlers, sh)
			p.shipper = sh
			p.shutdown = append(p.shutdown, sh.Shutdown)
			p.Enabled["logs_opensearch"] = true
		}
	}

	p.Logger = slog.New(&traceHandler{next: MultiHandler(handlers...)})
	slog.SetDefault(p.Logger)
	p.Enabled["logs_stdout"] = true
	return p, nil
}

// Shutdown flushes every pipeline. Callers should give it a few seconds: a
// dropped batch of traces is cosmetic, a dropped batch of logs is an incident
// with no evidence.
func (p *Provider) Shutdown(ctx context.Context) error {
	if p == nil {
		return nil
	}
	var errs []error
	// Reverse order: log shipper last so it can report earlier failures.
	for i := len(p.shutdown) - 1; i >= 0; i-- {
		if err := p.shutdown[i](ctx); err != nil && !errors.Is(err, context.Canceled) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// TracerName / ScopeName identify Lura's instrumentation scope.
const (
	TracerName = "github.com/HarshSingh21/locnot"
	ScopeName  = "github.com/HarshSingh21/locnot"
)

// Tracer returns the process tracer. Safe before Setup (it is a no-op tracer).
func Tracer() trace.Tracer { return otel.Tracer(TracerName) }

// Start begins a span on the process tracer.
func Start(ctx context.Context, name string, opts ...trace.SpanStartOption) (context.Context, trace.Span) {
	return Tracer().Start(ctx, name, opts...)
}

func (o Options) withDefaults() Options {
	if o.ServiceName == "" {
		o.ServiceName = "lura"
	}
	if o.ServiceVersion == "" {
		o.ServiceVersion = "dev"
	}
	if o.Environment == "" {
		o.Environment = "development"
	}
	if o.InstanceID == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "unknown"
		}
		o.InstanceID = host
	}
	if o.TraceSampleRatio <= 0 {
		o.TraceSampleRatio = 1
	}
	if o.MetricInterval <= 0 {
		o.MetricInterval = 15 * time.Second
	}
	if o.OpenSearchIndex == "" {
		o.OpenSearchIndex = "lura-logs"
	}
	if o.LogWriter == nil {
		o.LogWriter = os.Stdout
	}
	return o
}

func traceOpts(base string, o Options) []otlptracehttp.Option {
	opts := []otlptracehttp.Option{otlptracehttp.WithEndpointURL(joinOTLP(base, "/v1/traces"))}
	if o.OTLPInsecure || strings.HasPrefix(base, "http://") {
		opts = append(opts, otlptracehttp.WithInsecure())
	}
	if len(o.OTLPHeaders) > 0 {
		opts = append(opts, otlptracehttp.WithHeaders(o.OTLPHeaders))
	}
	return opts
}

func metricOpts(base string, o Options) []otlpmetrichttp.Option {
	opts := []otlpmetrichttp.Option{otlpmetrichttp.WithEndpointURL(joinOTLP(base, "/v1/metrics"))}
	if o.OTLPInsecure || strings.HasPrefix(base, "http://") {
		opts = append(opts, otlpmetrichttp.WithInsecure())
	}
	if len(o.OTLPHeaders) > 0 {
		opts = append(opts, otlpmetrichttp.WithHeaders(o.OTLPHeaders))
	}
	return opts
}

func logOpts(base string, o Options) []otlploghttp.Option {
	opts := []otlploghttp.Option{otlploghttp.WithEndpointURL(joinOTLP(base, "/v1/logs"))}
	if o.OTLPInsecure || strings.HasPrefix(base, "http://") {
		opts = append(opts, otlploghttp.WithInsecure())
	}
	if len(o.OTLPHeaders) > 0 {
		opts = append(opts, otlploghttp.WithHeaders(o.OTLPHeaders))
	}
	return opts
}

// joinOTLP appends the signal path unless the operator already supplied one,
// which is the usual foot-gun with OTEL_EXPORTER_OTLP_ENDPOINT.
func joinOTLP(base, path string) string {
	base = strings.TrimRight(base, "/")
	if strings.HasSuffix(base, path) {
		return base
	}
	return base + path
}
