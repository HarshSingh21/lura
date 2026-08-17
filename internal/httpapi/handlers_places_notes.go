package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/go-chi/chi/v5"
)

// ---------------------------------------------------------------- places

// radius bounds. Below ~20 m a circle is inside GPS noise and would fire
// constantly; above 5 km it is a region, not a place, and pass-by loses meaning.
const (
	minRadiusM = 20
	maxRadiusM = 5000
)

type placeRequest struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	Tags      []string         `json:"tags"`
	Center    *domain.Point    `json:"center"`
	RadiusM   *int             `json:"radiusM"`
	Triggers  []domain.Trigger `json:"triggers"`
	DwellMins *int             `json:"dwellMins"`
}

func (s *Server) handleListPlaces(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	places, err := s.deps.Store.ListPlaces(ctx, userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	stats, err := s.deps.Store.PlaceStats(ctx, userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	out := make([]placeView, 0, len(places))
	for _, p := range places {
		out = append(out, placeView{Place: p, Stats: stats[p.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"places": out})
}

func (s *Server) handleGetPlace(w http.ResponseWriter, r *http.Request) {
	place, err := s.requirePlace(r, chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"place": place})
}

func (s *Server) handleCreatePlace(w http.ResponseWriter, r *http.Request) {
	var req placeRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	place := domain.Place{
		ID:       req.ID,
		UserID:   userID(r),
		Name:     strings.TrimSpace(req.Name),
		Tags:     domain.NormalizeTags(req.Tags),
		Triggers: req.Triggers,
	}
	if req.Center != nil {
		place.Center = *req.Center
	}
	if req.RadiusM != nil {
		place.RadiusM = *req.RadiusM
	}
	if req.DwellMins != nil {
		place.DwellMins = *req.DwellMins
	}
	if len(place.Triggers) == 0 {
		place.Triggers = []domain.Trigger{domain.TriggerArrive}
	}
	if err := validatePlace(place); err != nil {
		s.writeError(w, r, err)
		return
	}

	created, err := s.deps.Store.CreatePlace(r.Context(), place)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	s.log.InfoContext(r.Context(), "place created",
		"place", created.ID, "name", created.Name, "radiusM", created.RadiusM, "triggers", created.Triggers)
	writeJSON(w, http.StatusCreated, map[string]any{"place": created})
}

// handleUpdatePlace serves both PUT and PATCH: absent fields keep their value,
// which makes "drag the radius handle" a one-field request.
//
// Mutating a place bumps UpdatedAt, and that is deliberate: UpdatedAt is part of
// the AI Brain's embedding cache key, so a rename or retag can never be answered
// from a stale embedding (HLD §5.7, "Cache invalidation (fixed)").
func (s *Server) handleUpdatePlace(w http.ResponseWriter, r *http.Request) {
	place, err := s.requirePlace(r, chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var req placeRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if n := strings.TrimSpace(req.Name); n != "" {
		place.Name = n
	}
	if req.Tags != nil {
		place.Tags = domain.NormalizeTags(req.Tags)
	}
	if req.Center != nil {
		place.Center = *req.Center
	}
	if req.RadiusM != nil {
		place.RadiusM = *req.RadiusM
	}
	if req.Triggers != nil {
		place.Triggers = req.Triggers
	}
	if req.DwellMins != nil {
		place.DwellMins = *req.DwellMins
	}
	if err := validatePlace(place); err != nil {
		s.writeError(w, r, err)
		return
	}

	updated, err := s.deps.Store.UpdatePlace(r.Context(), place)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"place": updated})
}

func (s *Server) handleDeletePlace(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Store.DeletePlace(r.Context(), userID(r), chi.URLParam(r, "id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func validatePlace(p domain.Place) error {
	if p.Name == "" {
		return errInvalid("name is required")
	}
	if len(p.Name) > 120 {
		return errInvalid("name is too long (max 120)")
	}
	if !geo.Valid(p.Center.Lat, p.Center.Lon) || (p.Center.Lat == 0 && p.Center.Lon == 0) {
		return errInvalid("center must be a valid lat/lon")
	}
	if p.RadiusM < minRadiusM || p.RadiusM > maxRadiusM {
		return errInvalid("radiusM must be between 20 and 5000")
	}
	if len(p.Triggers) == 0 {
		return errInvalid("at least one trigger is required")
	}
	seen := map[domain.Trigger]bool{}
	dwell := false
	for _, t := range p.Triggers {
		if !domain.ValidTrigger(t) {
			return errInvalid("unknown trigger " + string(t))
		}
		if seen[t] {
			return errInvalid("duplicate trigger " + string(t))
		}
		seen[t] = true
		if t == domain.TriggerDwell {
			dwell = true
		}
	}
	if dwell && p.DwellMins < 0 {
		return errInvalid("dwellMins must be >= 0")
	}
	if p.DwellMins > 24*60 {
		return errInvalid("dwellMins must be <= 1440")
	}
	return nil
}

// ---------------------------------------------------------------- notes

type noteRequest struct {
	ID          string          `json:"id"`
	Text        string          `json:"text"`
	PlaceID     *string         `json:"placeId"`
	Trigger     *domain.Trigger `json:"trigger"`
	Tags        []string        `json:"tags"`
	Channel     *string         `json:"channel"`
	Done        *bool           `json:"done"`
	AutoSuggest *bool           `json:"autoSuggest"`
}

func (s *Server) handleListNotes(w http.ResponseWriter, r *http.Request) {
	f := store.NoteFilter{
		PlaceID: r.URL.Query().Get("placeId"),
		Trigger: domain.Trigger(r.URL.Query().Get("trigger")),
		Limit:   queryInt(r, "limit", 0),
	}
	if v := r.URL.Query().Get("done"); v != "" {
		done := queryBool(r, "done", false)
		f.Done = &done
	}
	notes, err := s.deps.Store.ListNotes(r.Context(), userID(r), f)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": notes})
}

func (s *Server) handleGetNote(w http.ResponseWriter, r *http.Request) {
	note, err := s.deps.Store.GetNote(r.Context(), userID(r), chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"note": note})
}

// autoApplyConfidence is the bar a suggestion must clear before the server binds
// a note to a place without being told to. Below it the suggestion is returned
// for the user to accept — the flow HLD §7.3 describes.
const autoApplyConfidence = 0.55

// handleCreateNote creates a note, optionally binding it to a place via the AI
// Brain.
//
// The suggestion is always returned alongside the note, whether or not it was
// applied, so the composer can show what happened and offer an edit. A failing
// AI Brain never fails the request (HLD §10).
func (s *Server) handleCreateNote(w http.ResponseWriter, r *http.Request) {
	var req noteRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		s.writeError(w, r, errInvalid("text is required"))
		return
	}
	if len(text) > 2000 {
		s.writeError(w, r, errInvalid("text is too long (max 2000)"))
		return
	}

	ctx := r.Context()
	uid := userID(r)

	note := domain.Note{
		ID:      req.ID,
		UserID:  uid,
		Text:    text,
		Tags:    domain.NormalizeTags(req.Tags),
		Trigger: domain.TriggerArrive,
	}
	if req.PlaceID != nil {
		note.PlaceID = *req.PlaceID
	}
	if req.Trigger != nil {
		note.Trigger = *req.Trigger
	}
	if req.Channel != nil {
		note.Channel = *req.Channel
	}
	if req.Done != nil {
		note.Done = *req.Done
	}

	autoSuggest := req.AutoSuggest == nil || *req.AutoSuggest
	var suggestion *domain.Suggestion
	if autoSuggest {
		if sug, err := s.suggest(ctx, uid, text); err != nil {
			s.log.WarnContext(ctx, "note: suggestion unavailable, continuing without it", "error", err)
		} else {
			suggestion = &sug
			// Only fill what the client left blank: an explicit choice always wins
			// over the model.
			if note.PlaceID == "" && sug.PlaceID != "" && sug.Confidence >= autoApplyConfidence {
				note.PlaceID = sug.PlaceID
			}
			if req.Trigger == nil && sug.Trigger != "" {
				note.Trigger = sug.Trigger
			}
			if len(note.Tags) == 0 {
				note.Tags = sug.Tags
			}
		}
	}

	if !domain.ValidTrigger(note.Trigger) {
		s.writeError(w, r, errInvalid("unknown trigger "+string(note.Trigger)))
		return
	}
	if note.PlaceID != "" {
		place, err := s.deps.Store.GetPlace(ctx, uid, note.PlaceID)
		if err != nil {
			s.writeError(w, r, err)
			return
		}
		// A note whose trigger the place does not arm would never fire. Arm it
		// rather than silently creating a reminder that cannot work.
		if !placeHasTrigger(place, note.Trigger) {
			place.Triggers = append(place.Triggers, note.Trigger)
			if _, err := s.deps.Store.UpdatePlace(ctx, place); err != nil {
				s.writeError(w, r, err)
				return
			}
			s.log.InfoContext(ctx, "place trigger armed by note",
				"place", place.ID, "trigger", note.Trigger)
		}
	}

	created, err := s.deps.Store.CreateNote(ctx, note)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"note": created, "suggestion": suggestion})
}

func (s *Server) handleUpdateNote(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := userID(r)
	note, err := s.deps.Store.GetNote(ctx, uid, chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var req noteRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if t := strings.TrimSpace(req.Text); t != "" {
		note.Text = t
	}
	if req.PlaceID != nil {
		if *req.PlaceID != "" {
			if _, err := s.deps.Store.GetPlace(ctx, uid, *req.PlaceID); err != nil {
				s.writeError(w, r, err)
				return
			}
		}
		note.PlaceID = *req.PlaceID
	}
	if req.Trigger != nil {
		if !domain.ValidTrigger(*req.Trigger) {
			s.writeError(w, r, errInvalid("unknown trigger "+string(*req.Trigger)))
			return
		}
		note.Trigger = *req.Trigger
	}
	if req.Tags != nil {
		note.Tags = domain.NormalizeTags(req.Tags)
	}
	if req.Channel != nil {
		note.Channel = *req.Channel
	}
	if req.Done != nil {
		note.Done = *req.Done
	}

	updated, err := s.deps.Store.UpdateNote(ctx, note)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"note": updated})
}

func (s *Server) handleDeleteNote(w http.ResponseWriter, r *http.Request) {
	if err := s.deps.Store.DeleteNote(r.Context(), userID(r), chi.URLParam(r, "id")); err != nil {
		s.writeError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type suggestRequest struct {
	Text string `json:"text"`
}

// handleSuggest powers the composer's live "SUGGESTED …" row.
func (s *Server) handleSuggest(w http.ResponseWriter, r *http.Request) {
	var req suggestRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		s.writeError(w, r, errInvalid("text is required"))
		return
	}
	sug, err := s.suggest(r.Context(), userID(r), text)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"suggestion": sug})
}

// suggest loads the user's places and asks the AI Brain. Airgap mode forces the
// local rules engine even when a sidecar is configured, because a sidecar may be
// off-box (HLD §11).
func (s *Server) suggest(ctx context.Context, uid, text string) (domain.Suggestion, error) {
	places, err := s.deps.Store.ListPlaces(ctx, uid)
	if err != nil {
		return domain.Suggestion{}, err
	}
	engine := s.deps.AI
	if s.deps.Config.Airgap {
		engine = localSuggester
	}
	return engine.Suggest(ctx, text, places)
}

func placeHasTrigger(p domain.Place, t domain.Trigger) bool {
	for _, have := range p.Triggers {
		if have == t {
			return true
		}
	}
	return false
}
