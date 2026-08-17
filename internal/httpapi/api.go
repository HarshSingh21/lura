// Package httpapi is the API + WebSocket Gateway's transport layer.
//
// HLD §5.1 and §8: it terminates REST and WebSocket, authenticates, and hands
// work to the services. It contains no business rules — every handler is
// parse → authorize → call a service → render — which is what makes the Phase 2
// split into separate services a routing change rather than a rewrite.
//
// Route layout:
//
//	/pub                  OwnTracks-compatible ingest (device credentials)
//	/ws                   live updates for an authenticated user
//	/s/{token}            public share view (no account)
//	/s/{token}/ws         public share live stream
//	/api/v1/…             the control plane (bearer token)
//	/healthz /readyz /metrics /version
//
// The HLD lists the control-plane paths at the root (`/places`, `/notes`, …).
// They are namespaced under /api/v1 here so the same origin can also serve the
// web app and so the wire contract can version independently; /pub, /ws and
// /s/{token} keep their short root paths because OwnTracks clients and shared
// links depend on them being stable.
package httpapi

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/ai"
	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
)

// Deps is everything the API layer needs. Passing one struct keeps main's wiring
// readable and makes it obvious when a handler starts depending on something new.
type Deps struct {
	Config   config.Config
	Store    store.Store
	Bus      bus.Bus
	Hub      *hub.Hub
	Ingest   *ingest.Service
	Geofence *geofence.Engine
	Notify   *notify.Worker
	Shares   *share.Service
	Connect  *connect.Service
	History  *history.Service
	AI       ai.Suggester
	Auth     auth.Authenticator
	Devices  auth.Authenticator
	Obs      *obs.Provider
	Log      *slog.Logger
	Version  string
	Started  time.Time
}

// localSuggester is the always-available, never-egressing suggester. It backs
// airgap mode regardless of how the AI Brain is configured (HLD §11).
var localSuggester ai.Suggester = ai.NewRules()

// Server serves the API.
type Server struct {
	deps    Deps
	log     *slog.Logger
	router  chi.Router
	provisi *provisioner
}

// New builds the router.
func New(d Deps) *Server {
	log := d.Log
	if log == nil {
		log = slog.Default()
	}
	if d.Started.IsZero() {
		d.Started = time.Now()
	}
	s := &Server{deps: d, log: log}
	s.provisi = newProvisioner(s)
	s.routes()
	return s
}

// Handler returns the root http.Handler, wrapped in OpenTelemetry HTTP
// instrumentation so every request is a span with the matched chi route as its
// name.
func (s *Server) Handler() http.Handler {
	return otelhttp.NewHandler(s.router, "lura",
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
			if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
				return r.Method + " " + rc.RoutePattern()
			}
			return r.Method + " " + r.URL.Path
		}),
		otelhttp.WithFilter(func(r *http.Request) bool {
			// Scraping /metrics should not create a trace per scrape.
			return r.URL.Path != "/metrics"
		}),
	)
}

func (s *Server) routes() {
	r := chi.NewRouter()

	r.Use(chimw.RequestID)
	r.Use(chimw.RealIP)
	r.Use(s.recoverer)
	r.Use(s.requestLogger)
	r.Use(s.cors)

	// --- operations
	r.Get("/healthz", s.handleHealthz)
	r.Get("/readyz", s.handleReadyz)
	r.Get("/version", s.handleVersion)
	if s.deps.Obs != nil && s.deps.Obs.PromHandler != nil {
		r.Method(http.MethodGet, "/metrics", s.deps.Obs.PromHandler)
	}

	// --- ingest: device credentials, kept at the root for OwnTracks
	r.With(s.timeout(10*time.Second)).Post("/pub", s.handlePub)

	// --- live: WebSocket has no timeout middleware, by definition
	r.Get("/ws", s.handleWS)

	// --- public share endpoints: no account (HLD §5.8)
	r.Route("/s/{token}", func(r chi.Router) {
		r.Get("/", s.handleShareView)
		r.Get("/ws", s.handleShareWS)
	})

	// --- control plane
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(s.requireUser)
		r.Use(s.timeout(30 * time.Second))

		r.Get("/me", s.handleGetMe)
		r.Patch("/me", s.handlePatchMe)
		r.Get("/overview", s.handleOverview)
		r.Get("/events", s.handleListEvents)

		r.Route("/devices", func(r chi.Router) {
			r.Get("/", s.handleListDevices)
			r.Post("/", s.handleCreateDevice)
			r.Get("/{id}", s.handleGetDevice)
			r.Patch("/{id}", s.handleUpdateDevice)
			r.Delete("/{id}", s.handleDeleteDevice)
			r.Post("/{id}/token", s.handleRotateDeviceToken)
		})

		r.Route("/places", func(r chi.Router) {
			r.Get("/", s.handleListPlaces)
			r.Post("/", s.handleCreatePlace)
			r.Get("/{id}", s.handleGetPlace)
			r.Put("/{id}", s.handleUpdatePlace)
			r.Patch("/{id}", s.handleUpdatePlace)
			r.Delete("/{id}", s.handleDeletePlace)
		})

		r.Route("/notes", func(r chi.Router) {
			r.Get("/", s.handleListNotes)
			r.Post("/", s.handleCreateNote)
			r.Post("/suggest", s.handleSuggest)
			r.Get("/{id}", s.handleGetNote)
			r.Patch("/{id}", s.handleUpdateNote)
			r.Delete("/{id}", s.handleDeleteNote)
		})

		r.Route("/shares", func(r chi.Router) {
			r.Get("/", s.handleListShares)
			r.Post("/", s.handleCreateShare)
			r.Delete("/{id}", s.handleRevokeShare)
		})

		// People: mutual, two-way live sharing between accounts.
		r.Route("/people", func(r chi.Router) {
			r.Get("/", s.handleListPeople)
			r.Post("/invite", s.handleInvitePerson)
			r.Post("/{peerId}/accept", s.handleAcceptPerson)
			r.Patch("/{peerId}", s.handleUpdatePerson)
			r.Delete("/{peerId}", s.handleRemovePerson)
		})

		r.Route("/channels", func(r chi.Router) {
			r.Get("/", s.handleListChannels)
			r.Post("/", s.handleCreateChannel)
			r.Patch("/{id}", s.handleUpdateChannel)
			r.Delete("/{id}", s.handleDeleteChannel)
		})

		r.Route("/history", func(r chi.Router) {
			r.Get("/", s.handleHistory)
			r.Get("/export", s.handleHistoryExport)
			r.Delete("/", s.handleHistoryDelete)
		})
	})

	s.router = r
}

// ---------------------------------------------------------------- middleware

// requireUser enforces control-plane authentication and, for identities that
// come from an external IdP, makes sure the account exists before the handler
// runs — otherwise the first request after a sign-in would 404 on its own user.
func (s *Server) requireUser(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		principal, claims, err := s.identify(r)
		if err != nil {
			w.Header().Set("WWW-Authenticate", `Bearer realm="lura"`)
			s.writeError(w, r, err)
			return
		}
		if !principal.IsUser() {
			s.writeError(w, r, errInvalid("control plane requires a user token"))
			return
		}
		if err := s.provisi.ensure(r.Context(), principal, claims); err != nil {
			s.writeError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithPrincipal(r.Context(), principal)))
	})
}

// requestLogger records one structured line per request and feeds the HTTP
// metrics. The chi route pattern is used as the metric label so cardinality
// stays bounded — /places/{id}, never /places/plc_8f2k….
func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		ww := chimw.NewWrapResponseWriter(w, r.ProtoMajor)

		next.ServeHTTP(ww, r)

		route := r.URL.Path
		if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
			route = rc.RoutePattern()
		}
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}

		attrs := []any{
			"method", r.Method,
			"route", route,
			"path", r.URL.Path,
			"status", status,
			"bytes", ww.BytesWritten(),
			"duration", time.Since(start),
			"requestId", chimw.GetReqID(r.Context()),
		}
		switch {
		case status >= 500:
			metrics.HTTPErrors.Inc(metrics.AttrRoute.String(route))
			s.log.ErrorContext(r.Context(), "http", attrs...)
		case r.URL.Path == "/metrics" || r.URL.Path == "/healthz":
			// Scrapes and probes would drown the log; they are still counted.
		default:
			s.log.InfoContext(r.Context(), "http", attrs...)
		}

		metrics.HTTPRequests.Inc(
			metrics.AttrRoute.String(route),
			metrics.AttrMethod.String(r.Method),
			metrics.AttrStatus.Int(status),
		)
		metrics.HTTPSeconds.ObserveSince(start, metrics.AttrRoute.String(route))
	})
}

// recoverer turns a handler panic into a 500 plus a logged stack, rather than a
// dropped connection and a dead process.
func (s *Server) recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if rec == http.ErrAbortHandler {
					panic(rec) // the http package's own signal; do not swallow it
				}
				s.log.ErrorContext(r.Context(), "panic in handler",
					"method", r.Method, "path", r.URL.Path, "panic", rec,
					"stack", string(stack()))
				writeJSON(w, http.StatusInternalServerError, errorBody{
					Error: "internal error", Code: "internal",
				})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// timeout bounds handler execution. WebSocket routes deliberately skip it.
func (s *Server) timeout(d time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), d)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// cors allows the Expo web client (a different origin in development) to call
// the API, with an explicit allowlist rather than a blanket wildcard when the
// operator configures one.
func (s *Server) cors(next http.Handler) http.Handler {
	allowed := s.deps.Config.AllowedOrigins
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && originAllowed(allowed, origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Lura-Token")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func originAllowed(allowed []string, origin string) bool {
	for _, a := range allowed {
		if a == "*" || strings.EqualFold(a, origin) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- helpers

// userID returns the authenticated user for a control-plane request.
func userID(r *http.Request) string { return auth.UserID(r.Context()) }

// requirePlace loads a place the user owns.
func (s *Server) requirePlace(r *http.Request, id string) (domain.Place, error) {
	if id == "" {
		return domain.Place{}, errInvalid("place id required")
	}
	return s.deps.Store.GetPlace(r.Context(), userID(r), id)
}
