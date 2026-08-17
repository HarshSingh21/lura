// Package config loads Lura's runtime configuration from the environment.
//
// Every knob the HLD leaves as a product decision (fly-by aggressiveness,
// cool-off length, freshness window, retention) is a config value rather than a
// constant, because §17 lists them as still-open defaults.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the full server configuration.
type Config struct {
	// --- transport
	HTTPAddr       string   // listen address, e.g. ":8080"
	PublicBaseURL  string   // how clients reach this server; used to build share links
	AllowedOrigins []string // CORS/WebSocket origin allowlist; "*" allows any
	ShutdownGrace  time.Duration

	// --- storage
	StoreKind   string // "postgres" | "memory"
	DatabaseURL string
	Migrate     bool // run migrations on boot (Phase 1 convenience)
	Seed        bool // seed the demo workspace if the store is empty

	// --- auth
	//
	// Phase 1 shipped a single static bearer token. With an OIDC issuer
	// configured (Keycloak), the control plane takes real per-user JWTs instead
	// and the static token is off unless explicitly re-enabled for development.
	// Device ingest keeps its own per-device credential either way: a tracker
	// cannot perform an interactive login.
	APIToken         string // control-plane bearer token (development)
	DeviceToken      string // optional shared ingest token for the seeded device
	OIDCIssuer       string // e.g. http://localhost:8085/realms/lura; empty disables OIDC
	OIDCAudience     string // expected `aud` claim, e.g. lura-api
	DefaultTZ        string // timezone new accounts start in (IANA name)
	DevTokenWithOIDC bool   // allow the static token alongside OIDC (development only)

	// --- geofence engine (HLD §5.4)
	FreshWindow        time.Duration // ignore fixes older than this for firing
	ArriveDebounce     time.Duration // time inside a fence before "arrive" confirms
	ArriveMaxSpeedMPS  float64       // or confirm early when speed drops below this
	PassbyMinSpeedMPS  float64       // enter-while-moving threshold for pass-by
	CoolOff            time.Duration // per (device, place, trigger) suppression window
	DwellTick          time.Duration // how often armed dwell timers are checked
	GeofencePartitions int           // per-device partitions (ordering guarantee)

	// --- ingest (HLD §5.2)
	IngestRatePerMin int // per-device fix budget
	IngestBurst      int

	// --- notification (HLD §5.6)
	NtfyBaseURL string
	NtfyTopic   string
	WebhookURL  string
	NotifyTries int
	NotifyDelay time.Duration

	// --- AI Brain (HLD §5.7)
	AISidecarURL string // empty = Phase 1 Go keyword rules
	AITimeout    time.Duration

	// --- privacy (HLD §11)
	Airgap        bool // no outbound calls at all, overrides notifier/AI egress
	RetentionDays int  // 0 = keep forever

	// --- maps (HLD §13)
	MapStyleURL string

	// --- observability (HLD §12): OpenTelemetry for traces/metrics/logs,
	// Prometheus for pull-based metrics, OpenSearch as the log store. All
	// exporters are suppressed in airgap mode.
	ServiceName      string
	ServiceVersion   string
	Environment      string
	OTLPEndpoint     string // e.g. http://localhost:4318 (collector); empty disables OTLP
	OTLPInsecure     bool
	TraceSampleRatio float64
	MetricInterval   time.Duration
	EnableTraces     bool
	EnableMetrics    bool
	EnableOTLPLogs   bool
	EnablePrometheus bool

	OpenSearchURL      string // e.g. http://localhost:9200; empty disables shipping
	OpenSearchIndex    string
	OpenSearchUser     string
	OpenSearchPassword string
	OpenSearchInsecure bool

	// --- logging
	LogLevel  string // debug | info | warn | error
	LogFormat string // text | json
}

// Default returns the zero-infrastructure defaults: memory store, seeded demo
// workspace, everything else conservative.
func Default() Config {
	return Config{
		HTTPAddr:       ":8080",
		PublicBaseURL:  "http://localhost:8080",
		AllowedOrigins: []string{"*"},
		ShutdownGrace:  10 * time.Second,

		StoreKind:   "memory",
		DatabaseURL: "postgres://lura:lura@localhost:5432/lura?sslmode=disable",
		Migrate:     true,
		Seed:        true,

		APIToken:     "lura-dev-token",
		OIDCAudience: "lura-api",

		// Fly-by filter defaults: 45 s inside the fence confirms an arrival, or
		// sooner if the device slows to walking pace (1.5 m/s ≈ 5.4 km/h).
		FreshWindow:        5 * time.Minute,
		ArriveDebounce:     45 * time.Second,
		ArriveMaxSpeedMPS:  1.5,
		PassbyMinSpeedMPS:  3.0,
		CoolOff:            30 * time.Minute,
		DwellTick:          10 * time.Second,
		GeofencePartitions: 4,

		IngestRatePerMin: 240, // a fix every 250 ms sustained, well above the 20 s norm
		IngestBurst:      60,

		NtfyBaseURL: "https://ntfy.sh",
		NtfyTopic:   "",
		NotifyTries: 3,
		NotifyDelay: 500 * time.Millisecond,

		AITimeout: 2 * time.Second,

		RetentionDays: 90,

		MapStyleURL: "https://tiles.openfreemap.org/styles/positron",

		ServiceName:      "lura",
		ServiceVersion:   "0.1.0-phase1",
		Environment:      "development",
		OTLPEndpoint:     "", // set LURA_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_ENDPOINT) to enable
		OTLPInsecure:     true,
		TraceSampleRatio: 1.0,
		MetricInterval:   15 * time.Second,
		EnableTraces:     true,
		EnableMetrics:    true,
		EnableOTLPLogs:   true,
		EnablePrometheus: true,

		OpenSearchIndex: "lura-logs",

		LogLevel:  "info",
		LogFormat: "text",
	}
}

// Load builds a Config from Default() overlaid with LURA_* environment
// variables.
func Load() (Config, error) {
	c := Default()

	c.HTTPAddr = env("LURA_HTTP_ADDR", c.HTTPAddr)
	c.PublicBaseURL = strings.TrimRight(env("LURA_PUBLIC_BASE_URL", c.PublicBaseURL), "/")
	if v := os.Getenv("LURA_ALLOWED_ORIGINS"); v != "" {
		c.AllowedOrigins = splitList(v)
	}
	c.ShutdownGrace = envDur("LURA_SHUTDOWN_GRACE", c.ShutdownGrace)

	c.StoreKind = strings.ToLower(env("LURA_STORE", c.StoreKind))
	c.DatabaseURL = env("LURA_DATABASE_URL", env("DATABASE_URL", c.DatabaseURL))
	c.Migrate = envBool("LURA_MIGRATE", c.Migrate)
	c.Seed = envBool("LURA_SEED", c.Seed)

	c.APIToken = env("LURA_API_TOKEN", c.APIToken)
	c.DeviceToken = env("LURA_DEVICE_TOKEN", c.DeviceToken)
	c.OIDCIssuer = strings.TrimRight(env("LURA_OIDC_ISSUER", c.OIDCIssuer), "/")
	c.OIDCAudience = env("LURA_OIDC_AUDIENCE", c.OIDCAudience)
	c.DevTokenWithOIDC = envBool("LURA_DEV_TOKEN_WITH_OIDC", c.DevTokenWithOIDC)
	c.DefaultTZ = env("LURA_DEFAULT_TZ", c.DefaultTZ)

	c.FreshWindow = envDur("LURA_FRESH_WINDOW", c.FreshWindow)
	c.ArriveDebounce = envDur("LURA_ARRIVE_DEBOUNCE", c.ArriveDebounce)
	c.ArriveMaxSpeedMPS = envFloat("LURA_ARRIVE_MAX_SPEED_MPS", c.ArriveMaxSpeedMPS)
	c.PassbyMinSpeedMPS = envFloat("LURA_PASSBY_MIN_SPEED_MPS", c.PassbyMinSpeedMPS)
	c.CoolOff = envDur("LURA_COOLOFF", c.CoolOff)
	c.DwellTick = envDur("LURA_DWELL_TICK", c.DwellTick)
	c.GeofencePartitions = envInt("LURA_GEOFENCE_PARTITIONS", c.GeofencePartitions)

	c.IngestRatePerMin = envInt("LURA_INGEST_RATE_PER_MIN", c.IngestRatePerMin)
	c.IngestBurst = envInt("LURA_INGEST_BURST", c.IngestBurst)

	c.NtfyBaseURL = strings.TrimRight(env("LURA_NTFY_URL", c.NtfyBaseURL), "/")
	c.NtfyTopic = env("LURA_NTFY_TOPIC", c.NtfyTopic)
	c.WebhookURL = env("LURA_WEBHOOK_URL", c.WebhookURL)
	c.NotifyTries = envInt("LURA_NOTIFY_TRIES", c.NotifyTries)
	c.NotifyDelay = envDur("LURA_NOTIFY_RETRY_DELAY", c.NotifyDelay)

	c.AISidecarURL = strings.TrimRight(env("LURA_AI_URL", c.AISidecarURL), "/")
	c.AITimeout = envDur("LURA_AI_TIMEOUT", c.AITimeout)

	c.Airgap = envBool("LURA_AIRGAP", c.Airgap)
	c.RetentionDays = envInt("LURA_RETENTION_DAYS", c.RetentionDays)

	c.MapStyleURL = env("LURA_MAP_STYLE_URL", c.MapStyleURL)

	c.ServiceName = env("LURA_SERVICE_NAME", env("OTEL_SERVICE_NAME", c.ServiceName))
	c.ServiceVersion = env("LURA_SERVICE_VERSION", c.ServiceVersion)
	c.Environment = env("LURA_ENV", c.Environment)
	c.OTLPEndpoint = strings.TrimRight(env("LURA_OTLP_ENDPOINT", env("OTEL_EXPORTER_OTLP_ENDPOINT", c.OTLPEndpoint)), "/")
	c.OTLPInsecure = envBool("LURA_OTLP_INSECURE", c.OTLPInsecure)
	c.TraceSampleRatio = envFloat("LURA_TRACE_SAMPLE_RATIO", c.TraceSampleRatio)
	c.MetricInterval = envDur("LURA_METRIC_INTERVAL", c.MetricInterval)
	c.EnableTraces = envBool("LURA_ENABLE_TRACES", c.EnableTraces)
	c.EnableMetrics = envBool("LURA_ENABLE_METRICS", c.EnableMetrics)
	c.EnableOTLPLogs = envBool("LURA_ENABLE_OTLP_LOGS", c.EnableOTLPLogs)
	c.EnablePrometheus = envBool("LURA_ENABLE_PROMETHEUS", c.EnablePrometheus)

	c.OpenSearchURL = strings.TrimRight(env("LURA_OPENSEARCH_URL", c.OpenSearchURL), "/")
	c.OpenSearchIndex = env("LURA_OPENSEARCH_INDEX", c.OpenSearchIndex)
	c.OpenSearchUser = env("LURA_OPENSEARCH_USER", c.OpenSearchUser)
	c.OpenSearchPassword = env("LURA_OPENSEARCH_PASSWORD", c.OpenSearchPassword)
	c.OpenSearchInsecure = envBool("LURA_OPENSEARCH_INSECURE_TLS", c.OpenSearchInsecure)

	c.LogLevel = strings.ToLower(env("LURA_LOG_LEVEL", c.LogLevel))
	c.LogFormat = strings.ToLower(env("LURA_LOG_FORMAT", c.LogFormat))

	return c, c.Validate()
}

// Validate rejects configurations that would fail confusingly at runtime.
func (c Config) Validate() error {
	var errs []error
	if c.HTTPAddr == "" {
		errs = append(errs, errors.New("HTTPAddr is required"))
	}
	switch c.StoreKind {
	case "memory", "postgres":
	default:
		errs = append(errs, fmt.Errorf("unknown store %q (want memory or postgres)", c.StoreKind))
	}
	if c.StoreKind == "postgres" && c.DatabaseURL == "" {
		errs = append(errs, errors.New("LURA_DATABASE_URL is required with the postgres store"))
	}
	// With OIDC on, the static token is optional — real sessions replace it.
	if c.APIToken == "" && c.OIDCIssuer == "" {
		errs = append(errs, errors.New("LURA_API_TOKEN must not be empty without an OIDC issuer"))
	}
	if c.OIDCIssuer != "" && c.OIDCAudience == "" {
		errs = append(errs, errors.New("LURA_OIDC_AUDIENCE is required with an OIDC issuer"))
	}
	if c.GeofencePartitions < 1 {
		errs = append(errs, errors.New("LURA_GEOFENCE_PARTITIONS must be >= 1"))
	}
	if c.ArriveMaxSpeedMPS < 0 || c.PassbyMinSpeedMPS < 0 {
		errs = append(errs, errors.New("speed thresholds must be >= 0"))
	}
	if c.FreshWindow <= 0 {
		errs = append(errs, errors.New("LURA_FRESH_WINDOW must be > 0"))
	}
	if c.IngestRatePerMin < 1 {
		errs = append(errs, errors.New("LURA_INGEST_RATE_PER_MIN must be >= 1"))
	}
	return errors.Join(errs...)
}

// DefaultTimezone is the timezone a newly provisioned account starts in.
//
// Quiet hours are evaluated in the user's timezone, so an empty value would
// silently mean UTC and make "22:30–07:00" wrong for most of the world. The
// operator's own zone is a better guess than UTC, and the user can change it.
func (c Config) DefaultTimezone() string {
	if c.DefaultTZ != "" {
		return c.DefaultTZ
	}
	return "UTC"
}

// Redacted returns a log-safe summary: tokens and DSN credentials removed.
func (c Config) Redacted() map[string]any {
	return map[string]any{
		"httpAddr":           c.HTTPAddr,
		"publicBaseURL":      c.PublicBaseURL,
		"store":              c.StoreKind,
		"database":           redactDSN(c.DatabaseURL),
		"seed":               c.Seed,
		"migrate":            c.Migrate,
		"airgap":             c.Airgap,
		"freshWindow":        c.FreshWindow.String(),
		"arriveDebounce":     c.ArriveDebounce.String(),
		"arriveMaxSpeedMPS":  c.ArriveMaxSpeedMPS,
		"passbyMinSpeedMPS":  c.PassbyMinSpeedMPS,
		"coolOff":            c.CoolOff.String(),
		"geofencePartitions": c.GeofencePartitions,
		"retentionDays":      c.RetentionDays,
		"ntfy":               c.NtfyBaseURL != "" && c.NtfyTopic != "",
		"aiSidecar":          c.AISidecarURL != "",
		"otlpEndpoint":       c.OTLPEndpoint,
		"opensearch":         c.OpenSearchURL,
		"prometheus":         c.EnablePrometheus,
		"serviceName":        c.ServiceName,
		"environment":        c.Environment,
		"oidcIssuer":         c.OIDCIssuer,
		"oidcAudience":       c.OIDCAudience,
		"devTokenWithOIDC":   c.DevTokenWithOIDC,
	}
}

func redactDSN(dsn string) string {
	if dsn == "" {
		return ""
	}
	at := strings.LastIndex(dsn, "@")
	scheme := strings.Index(dsn, "://")
	if at < 0 || scheme < 0 || at < scheme {
		return dsn
	}
	return dsn[:scheme+3] + "***@" + dsn[at+1:]
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func envFloat(key string, def float64) float64 {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	f, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return def
	}
	return f
}

func envDur(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def
	}
	return d
}

func splitList(v string) []string {
	parts := strings.Split(v, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
