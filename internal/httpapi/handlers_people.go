package httpapi

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
)

// People: mutual live-location sharing between accounts (HLD §2.1).
//
// The endpoints are deliberately verb-shaped rather than a generic CRUD on a
// "connection" resource, because each transition is a distinct act of consent:
// inviting, accepting, pausing and removing are not the same operation with
// different fields.

type inviteRequest struct {
	Email string `json:"email"`
}

type sharingRequest struct {
	Sharing bool `json:"sharing"`
}

// handleListPeople returns this user's connections, including the live positions
// of the peers who are currently sharing with them.
func (s *Server) handleListPeople(w http.ResponseWriter, r *http.Request) {
	people, err := s.deps.Connect.List(r.Context(), userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	// Never cached: this payload says who can see whom right now.
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"people": list(people)})
}

func (s *Server) handleInvitePerson(w http.ResponseWriter, r *http.Request) {
	var req inviteRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if strings.TrimSpace(req.Email) == "" {
		s.writeError(w, r, errInvalid("email is required"))
		return
	}

	conn, err := s.deps.Connect.Invite(r.Context(), userID(r), req.Email)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	// A crossed invitation is an accept: both maps gain the other now.
	s.reauthorize(r, conn.PeerID)
	writeJSON(w, http.StatusCreated, map[string]any{"connection": conn})
}

func (s *Server) handleAcceptPerson(w http.ResponseWriter, r *http.Request) {
	conn, err := s.deps.Connect.Accept(r.Context(), userID(r), chi.URLParam(r, "peerId"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.reauthorize(r, conn.PeerID)
	writeJSON(w, http.StatusOK, map[string]any{"connection": conn})
}

// handleUpdatePerson flips this user's own sharing switch for one peer. It can
// only ever change the caller's row — the peer's switch is theirs alone.
func (s *Server) handleUpdatePerson(w http.ResponseWriter, r *http.Request) {
	var req sharingRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	conn, err := s.deps.Connect.SetSharing(r.Context(), userID(r), chi.URLParam(r, "peerId"), req.Sharing)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.reauthorize(r, conn.PeerID)
	writeJSON(w, http.StatusOK, map[string]any{"connection": conn})
}

// handleRemovePerson deletes the relationship from both sides.
func (s *Server) handleRemovePerson(w http.ResponseWriter, r *http.Request) {
	peerID := chi.URLParam(r, "peerId")
	if err := s.deps.Connect.Remove(r.Context(), userID(r), peerID); err != nil {
		s.writeError(w, r, err)
		return
	}
	s.reauthorize(r, peerID)
	w.WriteHeader(http.StatusNoContent)
}

// reauthorize applies a connection change to both people's open sockets on
// this replica before the response is written. "Paused" must mean the very
// next fix stays with its owner, not the one after the hub gets round to the
// asynchronous acl event (which still follows, and tells the clients).
func (s *Server) reauthorize(r *http.Request, peerID string) {
	if s.deps.Hub == nil {
		return
	}
	s.deps.Hub.Reauthorize(r.Context(), userID(r), peerID)
}
