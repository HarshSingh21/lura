package httpapi

import (
	"net/http"
	"strings"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/go-chi/chi/v5"
)

// ---------------------------------------------------------------- shares

type shareView struct {
	domain.Share
	Link string `json:"link"`
}

// handleListShares always lists the user's own shares, including the token, which
// is the point: the owner must be able to see, copy and revoke every link that
// exists. "Nothing covert" (HLD §11) is a listing guarantee, not just a UI habit.
func (s *Server) handleListShares(w http.ResponseWriter, r *http.Request) {
	shares, err := s.deps.Store.ListShares(r.Context(), userID(r), queryBool(r, "includeInactive", false))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]shareView, 0, len(shares))
	for _, sh := range shares {
		out = append(out, shareView{Share: sh, Link: s.deps.Shares.Link(sh)})
	}
	writeJSON(w, http.StatusOK, map[string]any{"shares": list(out)})
}

func (s *Server) handleCreateShare(w http.ResponseWriter, r *http.Request) {
	var req share.CreateRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	sh, link, err := s.deps.Shares.Create(r.Context(), userID(r), req)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"share": shareView{Share: sh, Link: link}})
}

func (s *Server) handleRevokeShare(w http.ResponseWriter, r *http.Request) {
	sh, err := s.deps.Shares.Revoke(r.Context(), userID(r), chi.URLParam(r, "id"), r.URL.Query().Get("reason"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"share": shareView{Share: sh, Link: s.deps.Shares.Link(sh)}})
}

// handleShareView is the public, unauthenticated share snapshot. It returns only
// what a recipient needs — a name, the shared devices' latest points, and how the
// share ends — and nothing about notes, places or history.
func (s *Server) handleShareView(w http.ResponseWriter, r *http.Request) {
	view, err := s.deps.Shares.View(r.Context(), chi.URLParam(r, "token"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	// Public and time-sensitive: never let a CDN or browser cache a live position.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, view)
}

// ---------------------------------------------------------------- channels

// knownChannelTypes are the delivery channels this build can actually use.
// Rejecting anything else means a typo surfaces when the channel is created, not
// silently at 7am when a reminder should have fired.
var knownChannelTypes = map[string]bool{
	"ntfy":    true,
	"webhook": true,
	"inapp":   true,
	"log":     true,
}

type channelRequest struct {
	Type     string            `json:"type"`
	Config   map[string]string `json:"config"`
	Enabled  *bool             `json:"enabled"`
	Priority *int              `json:"priority"`
}

func (s *Server) handleListChannels(w http.ResponseWriter, r *http.Request) {
	channels, err := s.deps.Store.ListChannels(r.Context(), userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"channels":  channels,
		"available": s.serverInfo().PushChannels,
	})
}

func (s *Server) handleCreateChannel(w http.ResponseWriter, r *http.Request) {
	var req channelRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))
	if !knownChannelTypes[req.Type] {
		s.writeError(w, r, errInvalid("unknown channel type "+req.Type))
		return
	}
	ch := domain.Channel{
		UserID:   userID(r),
		Type:     req.Type,
		Config:   req.Config,
		Enabled:  true,
		Priority: 10,
	}
	if req.Enabled != nil {
		ch.Enabled = *req.Enabled
	}
	if req.Priority != nil {
		ch.Priority = *req.Priority
	}
	created, err := s.deps.Store.CreateChannel(r.Context(), ch)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"channel": created})
}

func (s *Server) handleUpdateChannel(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := userID(r)
	id := chi.URLParam(r, "id")

	channels, err := s.deps.Store.ListChannels(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var current *domain.Channel
	for i := range channels {
		if channels[i].ID == id {
			current = &channels[i]
			break
		}
	}
	if current == nil {
		s.writeError(w, r, errNotFound("channel "+id+" not found"))
		return
	}

	var req channelRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if req.Type != "" {
		t := strings.ToLower(strings.TrimSpace(req.Type))
		if !knownChannelTypes[t] {
			s.writeError(w, r, errInvalid("unknown channel type "+t))
			return
		}
		current.Type = t
	}
	if req.Config != nil {
		current.Config = req.Config
	}
	if req.Enabled != nil {
		current.Enabled = *req.Enabled
	}
	if req.Priority != nil {
		current.Priority = *req.Priority
	}

	updated, err := s.deps.Store.UpdateChannel(ctx, *current)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": updated})
}

func (s *Server) handleDeleteChannel(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Store.DeleteChannel(r.Context(), userID(r), chi.URLParam(r, "id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
