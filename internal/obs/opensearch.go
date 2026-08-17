package obs

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/metrics"
	"go.opentelemetry.io/otel/trace"
)

// OpenSearchConfig configures the log shipper.
type OpenSearchConfig struct {
	URL         string // e.g. http://localhost:9200
	Index       string // index prefix; daily indices are <prefix>-YYYY.MM.DD
	Username    string
	Password    string
	InsecureTLS bool // self-signed certs are the norm for a self-hosted cluster

	ServiceName    string
	ServiceVersion string
	Environment    string
	InstanceID     string

	Level slog.Level

	BatchSize     int
	FlushInterval time.Duration
	QueueSize     int
	MaxRetries    int
	Timeout       time.Duration

	// OnError reports shipping failures. It must not log through the shipper
	// itself, or a broken cluster becomes an infinite loop.
	OnError func(error)

	// Client overrides the HTTP client (tests).
	Client *http.Client
	// Now overrides the clock (tests).
	Now func() time.Time
}

// OpenSearchShipper is a slog.Handler that batches records into OpenSearch's
// _bulk API.
//
// Design constraints that shaped it:
//
//   - Handle must never block the caller. A location tracker's request path
//     cannot wait on a log cluster, so a full queue drops records and counts
//     them (lura.logs.dropped) rather than applying backpressure.
//   - The bulk request is retried with backoff, because a rolling OpenSearch
//     restart should cost a few seconds of buffering, not a gap in the audit
//     trail.
//   - Records are ECS-ish flat JSON with trace_id/span_id, so OpenSearch
//     Dashboards can pivot from a log line to the trace that produced it.
type OpenSearchShipper struct {
	cfg    OpenSearchConfig
	client *http.Client

	attrs  []slog.Attr // accumulated via WithAttrs
	groups []string    // accumulated via WithGroup

	queue  chan map[string]any
	done   chan struct{}
	wg     sync.WaitGroup
	closed sync.Once
}

// NewOpenSearchShipper starts the background shipper. It does not require the
// cluster to be reachable: an unreachable cluster is a warning, not a boot
// failure.
func NewOpenSearchShipper(cfg OpenSearchConfig) (*OpenSearchShipper, error) {
	if cfg.URL == "" {
		return nil, fmt.Errorf("obs: opensearch URL required")
	}
	cfg.URL = strings.TrimRight(cfg.URL, "/")
	if cfg.Index == "" {
		cfg.Index = "lura-logs"
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 200
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 2 * time.Second
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 4096
	}
	if cfg.MaxRetries <= 0 {
		cfg.MaxRetries = 3
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 10 * time.Second
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.OnError == nil {
		cfg.OnError = func(error) {}
	}

	client := cfg.Client
	if client == nil {
		tr := &http.Transport{
			MaxIdleConns:        4,
			IdleConnTimeout:     60 * time.Second,
			TLSHandshakeTimeout: 5 * time.Second,
		}
		if cfg.InsecureTLS {
			// Self-hosted clusters ship with a self-signed cert by default. This
			// is opt-in via config, never the default.
			tr.TLSClientConfig = &tls.Config{InsecureSkipVerify: true}
		}
		client = &http.Client{Timeout: cfg.Timeout, Transport: tr}
	}

	s := &OpenSearchShipper{
		cfg:    cfg,
		client: client,
		queue:  make(chan map[string]any, cfg.QueueSize),
		done:   make(chan struct{}),
	}

	s.wg.Add(1)
	go s.run()
	go s.ensureTemplate() // best effort, off the boot path

	return s, nil
}

// Enabled implements slog.Handler.
func (s *OpenSearchShipper) Enabled(_ context.Context, l slog.Level) bool {
	return l >= s.cfg.Level
}

// Handle implements slog.Handler. It is non-blocking.
func (s *OpenSearchShipper) Handle(ctx context.Context, r slog.Record) error {
	doc := map[string]any{
		"@timestamp":             r.Time.UTC().Format(time.RFC3339Nano),
		"log.level":              strings.ToLower(r.Level.String()),
		"message":                r.Message,
		"service.name":           s.cfg.ServiceName,
		"service.version":        s.cfg.ServiceVersion,
		"service.instance.id":    s.cfg.InstanceID,
		"deployment.environment": s.cfg.Environment,
	}
	if sc := trace.SpanContextFromContext(ctx); sc.IsValid() {
		doc["trace_id"] = sc.TraceID().String()
		doc["span_id"] = sc.SpanID().String()
	}
	for _, a := range s.attrs {
		putAttr(doc, s.groups, a)
	}
	r.Attrs(func(a slog.Attr) bool {
		putAttr(doc, s.groups, a)
		return true
	})

	select {
	case s.queue <- doc:
	default:
		// Queue full: the cluster is slow or down. Drop and count — the record
		// is still on stdout via the multi-handler, so nothing is truly lost.
		metrics.LogsDropped.Inc()
	}
	return nil
}

// WithAttrs implements slog.Handler.
func (s *OpenSearchShipper) WithAttrs(attrs []slog.Attr) slog.Handler {
	if len(attrs) == 0 {
		return s
	}
	clone := s.clone()
	clone.attrs = append(append([]slog.Attr(nil), s.attrs...), attrs...)
	return clone
}

// WithGroup implements slog.Handler.
func (s *OpenSearchShipper) WithGroup(name string) slog.Handler {
	if name == "" {
		return s
	}
	clone := s.clone()
	clone.groups = append(append([]string(nil), s.groups...), name)
	return clone
}

// clone shares the queue and worker: WithAttrs/WithGroup must produce a handler
// that ships to the same pipeline, only with different pre-set fields.
func (s *OpenSearchShipper) clone() *OpenSearchShipper {
	return &OpenSearchShipper{
		cfg:    s.cfg,
		client: s.client,
		attrs:  s.attrs,
		groups: s.groups,
		queue:  s.queue,
		done:   s.done,
	}
}

// Shutdown flushes buffered records and stops the worker.
func (s *OpenSearchShipper) Shutdown(ctx context.Context) error {
	s.closed.Do(func() { close(s.done) })
	finished := make(chan struct{})
	go func() { s.wg.Wait(); close(finished) }()
	select {
	case <-finished:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (s *OpenSearchShipper) run() {
	defer s.wg.Done()
	ticker := time.NewTicker(s.cfg.FlushInterval)
	defer ticker.Stop()

	batch := make([]map[string]any, 0, s.cfg.BatchSize)
	flush := func() {
		if len(batch) == 0 {
			return
		}
		s.send(batch)
		batch = batch[:0]
	}

	for {
		select {
		case doc := <-s.queue:
			batch = append(batch, doc)
			if len(batch) >= s.cfg.BatchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-s.done:
			// Drain whatever is queued so a clean shutdown keeps its logs.
			for {
				select {
				case doc := <-s.queue:
					batch = append(batch, doc)
					if len(batch) >= s.cfg.BatchSize {
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

func (s *OpenSearchShipper) send(batch []map[string]any) {
	index := s.cfg.Index + "-" + s.cfg.Now().UTC().Format("2006.01.02")
	var body bytes.Buffer
	meta := []byte(`{"index":{"_index":"` + index + `"}}` + "\n")
	for _, doc := range batch {
		line, err := json.Marshal(doc)
		if err != nil {
			continue // a record we cannot encode is a bug, not a reason to lose the batch
		}
		body.Write(meta)
		body.Write(line)
		body.WriteByte('\n')
	}

	delay := 200 * time.Millisecond
	for attempt := 1; attempt <= s.cfg.MaxRetries; attempt++ {
		err := s.post("/_bulk", "application/x-ndjson", bytes.NewReader(body.Bytes()))
		if err == nil {
			metrics.LogsShipped.Add(int64(len(batch)))
			return
		}
		if attempt == s.cfg.MaxRetries {
			metrics.LogsDropped.Add(int64(len(batch)))
			s.cfg.OnError(fmt.Errorf("bulk index %d records: %w", len(batch), err))
			return
		}
		select {
		case <-time.After(delay):
		case <-s.done:
			// Shutting down: one last try, then give up.
			if err := s.post("/_bulk", "application/x-ndjson", bytes.NewReader(body.Bytes())); err == nil {
				metrics.LogsShipped.Add(int64(len(batch)))
			} else {
				metrics.LogsDropped.Add(int64(len(batch)))
			}
			return
		}
		delay *= 2
	}
}

// ensureTemplate installs an index template so the daily indices get sane
// mappings (keyword for ids, date for @timestamp) instead of dynamic guesses
// that make trace_id un-searchable.
func (s *OpenSearchShipper) ensureTemplate() {
	tmpl := map[string]any{
		"index_patterns": []string{s.cfg.Index + "-*"},
		"template": map[string]any{
			"settings": map[string]any{
				"number_of_shards":   1,
				"number_of_replicas": 0,
			},
			"mappings": map[string]any{
				"dynamic_templates": []any{
					map[string]any{
						"strings_as_keyword": map[string]any{
							"match_mapping_type": "string",
							"mapping":            map[string]any{"type": "keyword", "ignore_above": 1024},
						},
					},
				},
				"properties": map[string]any{
					"@timestamp": map[string]any{"type": "date"},
					"message":    map[string]any{"type": "text"},
					"log.level":  map[string]any{"type": "keyword"},
					"trace_id":   map[string]any{"type": "keyword"},
					"span_id":    map[string]any{"type": "keyword"},
				},
			},
		},
	}
	payload, err := json.Marshal(tmpl)
	if err != nil {
		return
	}
	if err := s.put("/_index_template/"+s.cfg.Index, "application/json", bytes.NewReader(payload)); err != nil {
		s.cfg.OnError(fmt.Errorf("install index template: %w", err))
	}
}

func (s *OpenSearchShipper) post(path, contentType string, body io.Reader) error {
	return s.do(http.MethodPost, path, contentType, body)
}

func (s *OpenSearchShipper) put(path, contentType string, body io.Reader) error {
	return s.do(http.MethodPut, path, contentType, body)
}

func (s *OpenSearchShipper) do(method, path, contentType string, body io.Reader) error {
	ctx, cancel := context.WithTimeout(context.Background(), s.cfg.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, s.cfg.URL+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", contentType)
	if s.cfg.Username != "" {
		req.SetBasicAuth(s.cfg.Username, s.cfg.Password)
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()
	if resp.StatusCode >= 300 {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("opensearch %s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(snippet)))
	}
	return nil
}

// putAttr flattens a slog attribute into the document with dotted keys, so
// nested groups stay queryable in OpenSearch without nested mappings.
func putAttr(doc map[string]any, groups []string, a slog.Attr) {
	if a.Equal(slog.Attr{}) {
		return
	}
	key := a.Key
	if len(groups) > 0 {
		key = strings.Join(groups, ".") + "." + key
	}
	v := a.Value.Resolve()
	switch v.Kind() {
	case slog.KindGroup:
		inner := append(append([]string(nil), groups...), a.Key)
		for _, ga := range v.Group() {
			putAttr(doc, inner, ga)
		}
	case slog.KindTime:
		doc[key] = v.Time().UTC().Format(time.RFC3339Nano)
	case slog.KindDuration:
		doc[key+"_ms"] = float64(v.Duration().Nanoseconds()) / 1e6
	case slog.KindBool:
		doc[key] = v.Bool()
	case slog.KindInt64:
		doc[key] = v.Int64()
	case slog.KindUint64:
		doc[key] = v.Uint64()
	case slog.KindFloat64:
		doc[key] = v.Float64()
	case slog.KindString:
		doc[key] = v.String()
	case slog.KindAny:
		switch x := v.Any().(type) {
		case error:
			doc[key] = x.Error()
		case fmt.Stringer:
			doc[key] = x.String()
		default:
			// Anything else is rendered rather than shipped raw: an arbitrary
			// struct would fight the keyword mapping.
			doc[key] = fmt.Sprint(x)
		}
	default:
		doc[key] = v.String()
	}
}

var _ slog.Handler = (*OpenSearchShipper)(nil)
