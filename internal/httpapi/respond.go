package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"go.opentelemetry.io/otel/trace"
)

// maxBodyBytes caps request bodies. A location fix is a few hundred bytes; a
// megabyte is already generous and keeps a malicious client from making the
// server allocate on its behalf.
const maxBodyBytes = 1 << 20

// errorBody is the single error shape every endpoint returns, so clients need
// one error path rather than one per route.
type errorBody struct {
	Error   string `json:"error"`
	Code    string `json:"code"`
	TraceID string `json:"traceId,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	if v == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(v); err != nil {
		// The status line is already written, so there is nothing to salvage;
		// the request log records the failure.
		slog.Debug("httpapi: encode response failed", "error", err)
	}
}

// writeError maps a domain error to an HTTP status. Handlers return domain
// errors and let this be the only place that knows about status codes.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	status, code := statusFor(err)

	body := errorBody{Error: err.Error(), Code: code}
	if sc := trace.SpanContextFromContext(r.Context()); sc.IsValid() {
		body.TraceID = sc.TraceID().String()
	}

	// 5xx is our fault: log it with the request context so it lands in the trace
	// and in OpenSearch. 4xx is the caller's, and logging those at error level
	// only trains operators to ignore errors.
	if status >= 500 {
		s.log.ErrorContext(r.Context(), "request failed",
			"method", r.Method, "path", r.URL.Path, "status", status, "error", err)
	} else {
		s.log.DebugContext(r.Context(), "request rejected",
			"method", r.Method, "path", r.URL.Path, "status", status, "error", err)
	}

	writeJSON(w, status, body)
}

func statusFor(err error) (int, string) {
	switch {
	case errors.Is(err, domain.ErrNotFound):
		return http.StatusNotFound, "not_found"
	case errors.Is(err, domain.ErrInvalid):
		return http.StatusBadRequest, "invalid"
	case errors.Is(err, domain.ErrUnauthorized):
		return http.StatusUnauthorized, "unauthorized"
	case errors.Is(err, domain.ErrForbidden):
		return http.StatusForbidden, "forbidden"
	case errors.Is(err, domain.ErrConflict):
		return http.StatusConflict, "conflict"
	case errors.Is(err, ingest.ErrRateLimited):
		return http.StatusTooManyRequests, "rate_limited"
	default:
		return http.StatusInternalServerError, "internal"
	}
}

// decodeJSON reads a JSON body with a size cap and rejects unknown fields, so a
// client typo ("radius" for "radiusM") fails loudly instead of silently
// defaulting.
func decodeJSON(r *http.Request, dst any) error {
	body := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	dec := json.NewDecoder(body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errInvalid("request body is empty")
		}
		return errInvalid("invalid JSON: " + err.Error())
	}
	// Exactly one JSON value per request; trailing content is a client bug.
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errInvalid("unexpected content after JSON body")
	}
	return nil
}

// decodeJSONLenient is used for the OwnTracks edge, where clients send fields we
// do not model and must not be rejected for it.
func decodeJSONLenient(r *http.Request, dst any) error {
	body := http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	if err := json.NewDecoder(body).Decode(dst); err != nil {
		if errors.Is(err, io.EOF) {
			return errInvalid("request body is empty")
		}
		return errInvalid("invalid JSON: " + err.Error())
	}
	return nil
}

func errInvalid(msg string) error {
	return &wrapped{msg: msg, err: domain.ErrInvalid}
}

func errNotFound(msg string) error {
	return &wrapped{msg: msg, err: domain.ErrNotFound}
}

type wrapped struct {
	msg string
	err error
}

func (w *wrapped) Error() string { return w.msg }
func (w *wrapped) Unwrap() error { return w.err }

// ---------------------------------------------------------------- query params

func queryInt(r *http.Request, key string, def int) int {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func queryBool(r *http.Request, key string, def bool) bool {
	v := r.URL.Query().Get(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

// queryTime accepts RFC3339, a date, or a relative offset like "-24h", which is
// what makes "show me today" a single query string the UI can build.
func queryTime(r *http.Request, key string) (time.Time, error) {
	v := strings.TrimSpace(r.URL.Query().Get(key))
	if v == "" {
		return time.Time{}, nil
	}
	if strings.HasPrefix(v, "-") || strings.HasPrefix(v, "+") {
		d, err := time.ParseDuration(v)
		if err != nil {
			return time.Time{}, errInvalid(key + ": invalid duration " + v)
		}
		return time.Now().UTC().Add(d), nil
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02T15:04", "2006-01-02"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t.UTC(), nil
		}
	}
	if n, err := strconv.ParseInt(v, 10, 64); err == nil {
		return time.Unix(n, 0).UTC(), nil
	}
	return time.Time{}, errInvalid(key + ": unrecognised timestamp " + v)
}
