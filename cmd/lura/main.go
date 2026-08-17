// Command lura is the Phase 1 monolith: API + WebSocket gateway, ingest,
// position writer, geofence engine, notification worker, sharing and history in
// one process (HLD §15, "Phase 1 — single VM, Docker Compose").
//
// The composition below is the whole architecture in one page. Every component
// talks to the others through an interface — bus, store, gate, notifier,
// suggester — so the Phase 2 split into separate services is a change to this
// file plus a driver swap, not a rewrite of the components.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/HarshSingh21/locnot/internal/ai"
	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/httpapi"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
	"github.com/HarshSingh21/locnot/internal/store/postgres"
)

// version is stamped at build time: -ldflags "-X main.version=$(git describe)".
var version = "0.1.0-phase1"

func main() {
	if err := run(); err != nil {
		// The logger may not exist yet (config or observability failed), so this
		// last-resort path writes plainly to stderr.
		fmt.Fprintln(os.Stderr, "lura:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	// Flags override the environment for the handful of things people change
	// while iterating locally.
	var (
		addr      = flag.String("addr", cfg.HTTPAddr, "HTTP listen address")
		storeKind = flag.String("store", cfg.StoreKind, "store backend: postgres | memory")
		dbURL     = flag.String("db", cfg.DatabaseURL, "PostgreSQL DSN (postgres store)")
		apiToken  = flag.String("token", cfg.APIToken, "control-plane bearer token")
		webDir    = flag.String("web", os.Getenv("LURA_WEB_DIR"), "directory of built web assets to serve at /")
		doSeed    = flag.Bool("seed", cfg.Seed, "seed a demo workspace when the store is empty")
		showVer   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Println("lura", version)
		return nil
	}

	cfg.HTTPAddr, cfg.StoreKind, cfg.DatabaseURL, cfg.APIToken, cfg.Seed =
		*addr, strings.ToLower(*storeKind), *dbURL, *apiToken, *doSeed
	if err := cfg.Validate(); err != nil {
		return fmt.Errorf("config: %w", err)
	}

	// Signals cancel this context; everything downstream shuts down from it.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// ---- observability first, so every later step is traced and logged
	provider, err := obs.Setup(ctx, obs.Options{
		ServiceName:        cfg.ServiceName,
		ServiceVersion:     version,
		Environment:        cfg.Environment,
		OTLPEndpoint:       cfg.OTLPEndpoint,
		OTLPInsecure:       cfg.OTLPInsecure,
		EnableTraces:       cfg.EnableTraces,
		EnableMetrics:      cfg.EnableMetrics,
		EnableOTLPLogs:     cfg.EnableOTLPLogs,
		EnablePrometheus:   cfg.EnablePrometheus,
		TraceSampleRatio:   cfg.TraceSampleRatio,
		MetricInterval:     cfg.MetricInterval,
		OpenSearchURL:      cfg.OpenSearchURL,
		OpenSearchIndex:    cfg.OpenSearchIndex,
		OpenSearchUser:     cfg.OpenSearchUser,
		OpenSearchPassword: cfg.OpenSearchPassword,
		OpenSearchInsecure: cfg.OpenSearchInsecure,
		Airgap:             cfg.Airgap,
		LogLevel:           cfg.LogLevel,
		LogFormat:          cfg.LogFormat,
	})
	if err != nil {
		return fmt.Errorf("observability: %w", err)
	}
	log := provider.Logger
	defer func() {
		// A fresh context: the signal context is already cancelled by now, and
		// flushing telemetry is exactly the work that must still happen.
		flushCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := provider.Shutdown(flushCtx); err != nil {
			log.Warn("observability shutdown incomplete", "error", err)
		}
	}()

	log.Info("starting lura", "version", version, "config", cfg.Redacted(), "pipelines", provider.Enabled)

	// ---- storage
	st, err := openStore(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer func() {
		if err := st.Close(); err != nil {
			log.Warn("store close failed", "error", err)
		}
	}()

	// ---- demo workspace
	seeded, err := seed.Run(ctx, st, log, seed.Options{
		DeviceToken: cfg.DeviceToken,
		WithHistory: true,
		// Shares are a live grant of location data, so they are only seeded for
		// the throwaway in-memory demo, never into a real database.
		WithShares: cfg.StoreKind == "memory",
	})
	if err != nil {
		return fmt.Errorf("seed: %w", err)
	}
	if seeded.Created {
		log.Info("demo workspace ready",
			"user", seeded.User.ID, "device", seeded.PrimaryID,
			"pubToken", maskToken(seeded.PubToken), "places", seeded.Places, "positions", seeded.Positions)
	}

	// ---- bus: in-process now, core NATS + JetStream in Phase 2 (HLD §4)
	b := bus.NewInProcess(log)
	defer func() { _ = b.Close() }()

	// ---- gateway fan-out
	h, err := hub.New(b, log)
	if err != nil {
		return fmt.Errorf("hub: %w", err)
	}
	defer h.Close()

	// ---- ingest + position writer
	ing := ingest.New(b, log, cfg.IngestRatePerMin, cfg.IngestBurst)
	writer := ingest.NewWriter(st, b, log, ingest.WriterOptions{})
	if err := writer.Start(ctx); err != nil {
		return fmt.Errorf("position writer: %w", err)
	}
	defer writer.Stop()

	// ---- geofence engine
	engine := geofence.New(st, b, gate.NewMemory(), log, geofence.Config{
		FreshWindow:       cfg.FreshWindow,
		ArriveDebounce:    cfg.ArriveDebounce,
		ArriveMaxSpeedMPS: cfg.ArriveMaxSpeedMPS,
		PassbyMinSpeedMPS: cfg.PassbyMinSpeedMPS,
		CoolOff:           cfg.CoolOff,
		DwellTick:         cfg.DwellTick,
		Partitions:        cfg.GeofencePartitions,
	})
	if err := engine.Start(ctx); err != nil {
		return fmt.Errorf("geofence engine: %w", err)
	}
	defer engine.Stop()

	// ---- notification worker and its channels
	notifiers := []notify.Notifier{
		&notify.InApp{Bus: b},
		&notify.Log{Logger: log},
	}
	if cfg.NtfyTopic != "" {
		notifiers = append(notifiers, notify.NewNtfy(cfg.NtfyBaseURL, cfg.NtfyTopic, "", nil))
	}
	if cfg.WebhookURL != "" {
		notifiers = append(notifiers, notify.NewWebhook(cfg.WebhookURL, "", nil))
	}
	notifier := notify.NewWorker(st, b, log, notify.Config{
		Tries:      cfg.NotifyTries,
		RetryDelay: cfg.NotifyDelay,
		Airgap:     cfg.Airgap,
		BaseURL:    cfg.PublicBaseURL,
	}, notifiers...)
	if err := notifier.Start(ctx); err != nil {
		return fmt.Errorf("notification worker: %w", err)
	}
	defer notifier.Stop()

	// ---- sharing
	shares := share.New(st, b, log, cfg.PublicBaseURL)
	shares.Track(seeded.User.ID)
	if err := shares.Start(ctx); err != nil {
		return fmt.Errorf("share service: %w", err)
	}
	defer shares.Stop()

	// ---- people: mutual, two-way live sharing between accounts
	people := connect.New(st, b, log)

	// ---- history + retention
	hist := history.New(st, log, history.Config{})
	stopRetention := startRetention(ctx, hist, log, seeded.User.ID, cfg.RetentionDays)
	defer stopRetention()

	// ---- AI Brain: local rules unless a sidecar is configured and allowed
	var suggester ai.Suggester = ai.NewRules()
	if cfg.AISidecarURL != "" && !cfg.Airgap {
		suggester = ai.NewSidecar(cfg.AISidecarURL, cfg.AITimeout, ai.NewRules())
		log.Info("AI Brain sidecar configured", "url", cfg.AISidecarURL)
	}

	// ---- identity
	controlPlaneAuth, err := buildAuthenticator(ctx, cfg, log)
	if err != nil {
		return fmt.Errorf("identity: %w", err)
	}

	// ---- HTTP
	api := httpapi.New(httpapi.Deps{
		Config:   cfg,
		Store:    st,
		Bus:      b,
		Hub:      h,
		Ingest:   ing,
		Geofence: engine,
		Notify:   notifier,
		Shares:   shares,
		Connect:  people,
		History:  hist,
		AI:       suggester,
		Auth:     controlPlaneAuth,
		Devices:  &auth.DeviceAuth{Devices: st, APIToken: cfg.APIToken, UserID: seed.DemoUserID},
		Obs:      provider,
		Log:      log,
		Version:  version,
		Started:  time.Now(),
	})

	handler := api.Handler()
	if *webDir != "" {
		handler = withStatic(handler, *webDir, log)
	}

	srv := &http.Server{
		Addr:    cfg.HTTPAddr,
		Handler: handler,
		// No WriteTimeout: it would kill long-lived WebSocket connections. Read
		// deadlines are handled per-route instead.
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		ErrorLog:          slog.NewLogLogger(log.Handler(), slog.LevelWarn),
	}

	errc := make(chan error, 1)
	go func() {
		log.Info("listening",
			"addr", cfg.HTTPAddr, "publicBaseURL", cfg.PublicBaseURL,
			"store", st.Kind(), "web", *webDir != "")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
		log.Info("shutdown signal received", "grace", cfg.ShutdownGrace.String())
	}

	// Graceful shutdown: stop accepting, let in-flight requests finish, then let
	// the deferred Stop calls above drain the workers (which is why the workers
	// drain their queues rather than dropping them).
	shutdownCtx, cancel := context.WithTimeout(context.Background(), cfg.ShutdownGrace)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Warn("http shutdown timed out, closing", "error", err)
		_ = srv.Close()
	}
	log.Info("stopped cleanly")
	return nil
}

// buildAuthenticator chooses how the control plane authenticates.
//
// Without an OIDC issuer this is Phase 1's single static token, which is fine for
// a laptop and indefensible on a network. With one, every request carries a real
// per-user JWT from Keycloak, and the static token is refused unless the operator
// deliberately re-enables it — a shared password that still works is a shared
// password that will still be there in a year.
//
// Device ingest is unaffected either way: a tracker authenticates with its own
// per-device credential, because it cannot perform an interactive login.
func buildAuthenticator(ctx context.Context, cfg config.Config, log *slog.Logger) (auth.Authenticator, error) {
	if cfg.OIDCIssuer == "" {
		log.Warn("no OIDC issuer configured: the control plane accepts a single static token",
			"hint", "set LURA_OIDC_ISSUER to require real sign-in")
		return auth.NewStaticToken(cfg.APIToken, seed.DemoUserID), nil
	}

	verifier, err := auth.NewOIDC(ctx, auth.OIDCConfig{
		Issuer:   cfg.OIDCIssuer,
		Audience: cfg.OIDCAudience,
	})
	if err != nil {
		return nil, err
	}
	log.Info("control plane requires OIDC sign-in",
		"issuer", cfg.OIDCIssuer, "audience", cfg.OIDCAudience)

	if cfg.DevTokenWithOIDC && cfg.APIToken != "" {
		log.Warn("the static development token is ALSO accepted alongside OIDC",
			"hint", "unset LURA_DEV_TOKEN_WITH_OIDC before exposing this server")
		return auth.NewChain(verifier, auth.NewStaticToken(cfg.APIToken, seed.DemoUserID)), nil
	}
	return verifier, nil
}

// openStore builds the configured store, running migrations for postgres.
func openStore(ctx context.Context, cfg config.Config, log *slog.Logger) (store.Store, error) {
	switch cfg.StoreKind {
	case "memory":
		log.Warn("using the in-memory store: data is lost on restart (set LURA_STORE=postgres to persist)")
		return memory.New(), nil

	case "postgres":
		connectCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		pg, err := postgres.Open(connectCtx, cfg.DatabaseURL, log)
		if err != nil {
			return nil, fmt.Errorf("postgres: %w", err)
		}
		if cfg.Migrate {
			migrateCtx, cancelMigrate := context.WithTimeout(ctx, 2*time.Minute)
			defer cancelMigrate()
			if err := pg.Migrate(migrateCtx); err != nil {
				_ = pg.Close()
				return nil, fmt.Errorf("migrate: %w", err)
			}
		}
		return pg, nil

	default:
		return nil, fmt.Errorf("unknown store %q", cfg.StoreKind)
	}
}

// startRetention runs the retention sweep daily. Retention is a privacy promise
// (HLD §11), so it runs in-process rather than depending on an operator's cron.
func startRetention(ctx context.Context, hist *history.Service, log *slog.Logger, userID string, days int) func() {
	if days <= 0 {
		log.Info("history retention disabled: keeping positions forever")
		return func() {}
	}
	ctx, cancel := context.WithCancel(ctx)
	go func() {
		// One sweep shortly after boot catches up after downtime, then daily.
		timer := time.NewTimer(time.Minute)
		defer timer.Stop()
		for {
			select {
			case <-timer.C:
				if _, err := hist.Retain(ctx, userID, days); err != nil {
					log.Warn("retention sweep failed", "error", err)
				}
				timer.Reset(24 * time.Hour)
			case <-ctx.Done():
				return
			}
		}
	}()
	return cancel
}

// withStatic serves the built Expo web bundle alongside the API, so a
// single-binary deployment answers both the app and its API on one origin.
//
// Unknown paths fall back to index.html because Expo Router uses client-side
// routing: /places must return the app shell, not a 404.
func withStatic(api http.Handler, dir string, log *slog.Logger) http.Handler {
	if log == nil {
		log = slog.Default()
	}
	root, err := filepath.Abs(dir)
	if err != nil {
		log.Warn("web dir unusable, serving API only", "dir", dir, "error", err)
		return api
	}
	if _, err := os.Stat(filepath.Join(root, "index.html")); err != nil {
		log.Warn("web dir has no index.html, serving API only", "dir", root)
		return api
	}
	files := http.FileServer(http.Dir(root))
	log.Info("serving web assets", "dir", root)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isAPIPath(r.URL.Path) {
			api.ServeHTTP(w, r)
			return
		}
		// A request for an existing file is served as-is; anything else is a
		// client-side route.
		candidate := filepath.Join(root, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			files.ServeHTTP(w, r)
			return
		}

		// A missing *asset* is a 404, not the app shell. Serving index.html for a
		// missing .mjs chunk is how a bundling mistake turns into an opaque
		// "non-JavaScript MIME type" error in the console instead of an obvious
		// 404 — which is exactly how MapLibre's worker chunk went missing once.
		if ext := path.Ext(r.URL.Path); ext != "" && ext != ".html" {
			http.NotFound(w, r)
			return
		}

		http.ServeFile(w, r, filepath.Join(root, "index.html"))
	})
}

func isAPIPath(p string) bool {
	switch {
	case p == "/pub", p == "/ws", p == "/healthz", p == "/readyz", p == "/metrics", p == "/version":
		return true
	case strings.HasPrefix(p, "/api/"):
		return true
	case strings.HasPrefix(p, "/s/"):
		// Share links are server-rendered JSON at /s/{token} and a socket at
		// /s/{token}/ws; the web app uses /share/{token} for its own view.
		return true
	}
	return false
}

// maskToken keeps a credential out of the logs while leaving enough to match it
// against what a client is configured with.
func maskToken(t string) string {
	if len(t) <= 8 {
		return "********"
	}
	return t[:4] + "…" + t[len(t)-4:]
}
