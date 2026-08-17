package httpapi

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/ingest"
)

// ---------------------------------------------------------------- history

func (s *Server) historyQuery(r *http.Request) (history.Query, error) {
	from, err := queryTime(r, "from")
	if err != nil {
		return history.Query{}, err
	}
	to, err := queryTime(r, "to")
	if err != nil {
		return history.Query{}, err
	}
	return history.Query{
		DeviceID: r.URL.Query().Get("deviceId"),
		From:     from,
		To:       to,
		PlaceID:  r.URL.Query().Get("placeId"),
		// A day of 20-second fixes is ~4300 points; the cap protects the server
		// from a client asking for a year in one request.
		Limit: queryInt(r, "limit", 20000),
	}, nil
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	q, err := s.historyQuery(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	sum, err := s.deps.History.Summarise(r.Context(), userID(r), q)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

// handleHistoryExport streams GeoJSON or GPX. Export is a data right, not a
// feature (HLD §11), so it is a plain GET with a filename and no server-side job.
func (s *Server) handleHistoryExport(w http.ResponseWriter, r *http.Request) {
	q, err := s.historyQuery(r)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	sum, err := s.deps.History.Summarise(r.Context(), userID(r), q)
	if err != nil {
		s.writeError(w, r, err)
		return
	}

	format := strings.ToLower(r.URL.Query().Get("format"))
	if format == "" {
		format = "geojson"
	}

	var (
		body        []byte
		contentType string
		ext         string
	)
	switch format {
	case "geojson", "json":
		body, err = s.deps.History.GeoJSON(sum)
		contentType, ext = "application/geo+json", "geojson"
	case "gpx", "xml":
		body, err = s.deps.History.GPX(sum)
		contentType, ext = "application/gpx+xml", "gpx"
	default:
		s.writeError(w, r, errInvalid("format must be geojson or gpx"))
		return
	}
	if err != nil {
		s.writeError(w, r, err)
		return
	}

	name := "lura-history-" + sum.From.UTC().Format("20060102") + "." + ext
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(body); err != nil {
		s.log.DebugContext(r.Context(), "history: export write failed", "error", err)
	}
}

// handleHistoryDelete erases history — either everything before a timestamp or
// everything older than N days. The other half of the data-rights promise.
func (s *Server) handleHistoryDelete(w http.ResponseWriter, r *http.Request) {
	uid := userID(r)

	if days := queryInt(r, "olderThanDays", 0); days > 0 {
		n, err := s.deps.History.Retain(r.Context(), uid, days)
		if err != nil {
			s.writeError(w, r, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"deleted": n, "olderThanDays": days})
		return
	}

	before, err := queryTime(r, "before")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	if before.IsZero() {
		// Deleting everything must be asked for explicitly; an empty query string
		// wiping a user's whole history would be a catastrophic default.
		if !queryBool(r, "all", false) {
			s.writeError(w, r, errInvalid("pass before=<ts>, olderThanDays=<n>, or all=true"))
			return
		}
		before = time.Now().UTC()
	}
	n, err := s.deps.Store.DeletePositionsBefore(r.Context(), uid, before)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "history deleted", "user", uid, "before", before, "rows", n)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n, "before": before})
}

// ---------------------------------------------------------------- ingest

// handlePub is the OwnTracks-compatible ingest endpoint.
//
// The response shape follows the client: OwnTracks HTTP mode expects a JSON
// array (it treats the response as a list of messages to process), while Lura's
// own clients and the simulator want the stored position echoed back so they can
// confirm what the server recorded.
func (s *Server) handlePub(w http.ResponseWriter, r *http.Request) {
	principal, err := s.deps.Devices.Authenticate(r)
	if err != nil {
		w.Header().Set("WWW-Authenticate", `Bearer realm="lura-pub"`)
		s.writeError(w, r, err)
		return
	}

	var payload ingest.Payload
	// Lenient decoding: OwnTracks sends fields we do not model, and rejecting a
	// fix because a client added a field would break tracking for that client.
	if err := decodeJSONLenient(r, &payload); err != nil {
		s.writeError(w, r, err)
		return
	}

	dev, err := s.deps.Store.GetDevice(r.Context(), principal.UserID, principal.DeviceID)
	if err != nil {
		s.writeError(w, r, err)
		return
	}

	pos, err := s.deps.Ingest.Accept(r.Context(), dev, payload)
	if err != nil {
		if errors.Is(err, ingest.ErrRateLimited) {
			if retry := s.deps.Ingest.RetryAfter(dev.ID); retry > 0 {
				w.Header().Set("Retry-After", retryAfterSeconds(retry))
			}
		}
		s.writeError(w, r, err)
		return
	}

	if isOwnTracks(r, payload) {
		writeJSON(w, http.StatusOK, []any{})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ok", "position": pos})
}

func isOwnTracks(r *http.Request, p ingest.Payload) bool {
	if queryBool(r, "ot", false) {
		return true
	}
	if strings.Contains(strings.ToLower(r.UserAgent()), "owntracks") {
		return true
	}
	// A payload carrying _type and a tracker id but none of Lura's own fields is
	// almost certainly an OwnTracks client.
	return p.Type == "location" && p.TID != "" && p.SpeedMPS == nil && p.Seq == 0
}

func retryAfterSeconds(d time.Duration) string {
	secs := int(d.Seconds() + 0.999) // always round up: never invite an early retry
	if secs < 1 {
		secs = 1
	}
	return strconv.Itoa(secs)
}
