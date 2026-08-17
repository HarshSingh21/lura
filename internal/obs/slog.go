package obs

import (
	"context"
	"log/slog"
	"strings"

	"go.opentelemetry.io/otel/trace"
)

// multiHandler fans one log record out to several handlers (stdout, the OTel
// bridge, the OpenSearch shipper). A failing sink must not silence the others,
// so errors are collected rather than returned on the first failure.
type multiHandler struct {
	handlers []slog.Handler
}

// MultiHandler returns a slog.Handler that writes to all of handlers.
func MultiHandler(handlers ...slog.Handler) slog.Handler {
	switch len(handlers) {
	case 0:
		return discardHandler{}
	case 1:
		return handlers[0]
	}
	return &multiHandler{handlers: handlers}
}

func (m *multiHandler) Enabled(ctx context.Context, l slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(ctx, l) {
			return true
		}
	}
	return false
}

func (m *multiHandler) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range m.handlers {
		if !h.Enabled(ctx, r.Level) {
			continue
		}
		// Each handler gets its own clone: handlers are allowed to consume a
		// record's attrs, and slog.Record shares backing storage.
		if err := h.Handle(ctx, r.Clone()); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (m *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithAttrs(attrs)
	}
	return &multiHandler{handlers: next}
}

func (m *multiHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		next[i] = h.WithGroup(name)
	}
	return &multiHandler{handlers: next}
}

// traceHandler stamps trace_id/span_id onto every record that carries a
// sampled span, which is what makes "show me the logs for this trace" work in
// OpenSearch Dashboards without an OTel-aware log pipeline.
type traceHandler struct {
	next slog.Handler
}

func (t *traceHandler) Enabled(ctx context.Context, l slog.Level) bool {
	return t.next.Enabled(ctx, l)
}

func (t *traceHandler) Handle(ctx context.Context, r slog.Record) error {
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		r.AddAttrs(
			slog.String("trace_id", sc.TraceID().String()),
			slog.String("span_id", sc.SpanID().String()),
		)
	}
	return t.next.Handle(ctx, r)
}

func (t *traceHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &traceHandler{next: t.next.WithAttrs(attrs)}
}

func (t *traceHandler) WithGroup(name string) slog.Handler {
	return &traceHandler{next: t.next.WithGroup(name)}
}

type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (discardHandler) WithAttrs([]slog.Attr) slog.Handler        { return discardHandler{} }
func (discardHandler) WithGroup(string) slog.Handler             { return discardHandler{} }

func newStdoutHandler(o Options) slog.Handler {
	opts := &slog.HandlerOptions{Level: parseLevel(o.LogLevel)}
	if strings.EqualFold(o.LogFormat, "json") {
		return slog.NewJSONHandler(o.LogWriter, opts)
	}
	return slog.NewTextHandler(o.LogWriter, opts)
}

// parseLevel maps a config string to a slog level, defaulting to info.
func parseLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
