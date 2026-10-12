package httpapi

import (
	"net/http"

	"github.com/HarshSingh21/locnot/internal/activity"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/go-chi/chi/v5"
)

// ---------------------------------------------------------------- reminders

// handleListReminders serves GET /api/v1/reminders?status=pending|acknowledged|all&limit=.
// It is what a client loads on sign-in, page load and WebSocket reconnect, so
// a pending reminder is back on screen wherever the user next looks.
func (s *Server) handleListReminders(w http.ResponseWriter, r *http.Request) {
	f := store.ReminderFilter{Limit: queryInt(r, "limit", 100)}
	switch status := r.URL.Query().Get("status"); status {
	case "", "all":
	case string(domain.ReminderPending), string(domain.ReminderAcknowledged):
		f.Status = domain.ReminderStatus(status)
	default:
		s.writeError(w, r, errInvalid("status must be pending, acknowledged or all"))
		return
	}
	if f.Limit <= 0 || f.Limit > 500 {
		f.Limit = 500
	}
	reminders, err := s.deps.Store.ListReminders(r.Context(), userID(r), f)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"reminders": list(reminders)})
}

// handleAckReminder serves POST /api/v1/reminders/{id}/ack. Idempotent; only
// the recipient may call it — anyone else gets 404, the same as a missing id.
func (s *Server) handleAckReminder(w http.ResponseWriter, r *http.Request) {
	if s.deps.Notify == nil {
		s.writeError(w, r, errNotFound("reminders are not enabled"))
		return
	}
	res, err := s.deps.Notify.Acknowledge(r.Context(), userID(r), chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// ---------------------------------------------------------------- activity

// handleActivity serves GET /api/v1/activity?from=&to=&limit=: the merged,
// newest-first timeline of the user's own trips and stops, their fences'
// crossings, reminders and acknowledgements, and connection and share changes.
func (s *Server) handleActivity(w http.ResponseWriter, r *http.Request) {
	from, err := queryTime(r, "from")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	to, err := queryTime(r, "to")
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	res, err := s.deps.Activity.Feed(r.Context(), userID(r), activity.Query{
		From: from, To: to, Limit: queryInt(r, "limit", activity.DefaultLimit),
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
