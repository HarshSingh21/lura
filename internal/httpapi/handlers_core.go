package httpapi

import (
	"context"
	"net/http"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/go-chi/chi/v5"
)

func stack() []byte { return debug.Stack() }

// ---------------------------------------------------------------- operations

type healthResponse struct {
	Status      string              `json:"status"`
	Version     string              `json:"version"`
	Store       string              `json:"store"`
	UptimeSec   float64             `json:"uptimeSeconds"`
	WSClients   int                 `json:"wsClients"`
	Airgap      bool                `json:"airgap"`
	Pipelines   map[string]bool     `json:"observability"`
	Phase       string              `json:"phase"`
	Environment string              `json:"environment"`
	Inside      map[string][]string `json:"insidePlaces,omitempty"`
}

// handleHealthz is liveness plus a snapshot an operator can read at a glance.
func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	resp := healthResponse{
		Status:      "ok",
		Version:     s.deps.Version,
		Store:       s.deps.Store.Kind(),
		UptimeSec:   time.Since(s.deps.Started).Seconds(),
		Airgap:      s.deps.Config.Airgap,
		Phase:       "1",
		Environment: s.deps.Config.Environment,
	}
	if s.deps.Hub != nil {
		resp.WSClients = s.deps.Hub.Count()
	}
	if s.deps.Obs != nil {
		resp.Pipelines = s.deps.Obs.Enabled
	}
	if s.deps.Geofence != nil {
		resp.Inside = s.deps.Geofence.InsideSnapshot()
	}
	writeJSON(w, http.StatusOK, resp)
}

// handleReadyz reports whether dependencies are actually usable, which is what a
// load balancer should gate traffic on.
func (s *Server) handleReadyz(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := contextWithTimeout(r, 2*time.Second)
	defer cancel()
	if err := s.deps.Store.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"status": "unavailable", "store": s.deps.Store.Kind(), "error": err.Error(),
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"status": "ready", "store": s.deps.Store.Kind()})
}

func (s *Server) handleVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"version":     s.deps.Version,
		"service":     s.deps.Config.ServiceName,
		"environment": s.deps.Config.Environment,
		"phase":       "1",
	})
}

// ---------------------------------------------------------------- me

// serverInfo tells the client what this deployment can do, so the UI reflects
// the server's actual configuration instead of hard-coding it (map style,
// airgap, which phase's capabilities exist).
type serverInfo struct {
	Version       string   `json:"version"`
	Store         string   `json:"store"`
	MapStyleURL   string   `json:"mapStyleUrl"`
	Airgap        bool     `json:"airgap"`
	Phase         string   `json:"phase"`
	PublicBaseURL string   `json:"publicBaseUrl"`
	FreshWindowS  float64  `json:"freshWindowSeconds"`
	CoolOffS      float64  `json:"coolOffSeconds"`
	AIEngine      string   `json:"aiEngine"`
	PushChannels  []string `json:"pushChannels"`
}

func (s *Server) serverInfo() serverInfo {
	engine := "rules"
	if s.deps.Config.AISidecarURL != "" {
		engine = "minilm"
	}
	channels := []string{"inapp", "log"}
	if s.deps.Config.NtfyTopic != "" {
		channels = append(channels, "ntfy")
	}
	if s.deps.Config.WebhookURL != "" {
		channels = append(channels, "webhook")
	}
	return serverInfo{
		Version:       s.deps.Version,
		Store:         s.deps.Store.Kind(),
		MapStyleURL:   s.deps.Config.MapStyleURL,
		Airgap:        s.deps.Config.Airgap,
		Phase:         "1",
		PublicBaseURL: s.deps.Config.PublicBaseURL,
		FreshWindowS:  s.deps.Config.FreshWindow.Seconds(),
		CoolOffS:      s.deps.Config.CoolOff.Seconds(),
		AIEngine:      engine,
		PushChannels:  channels,
	}
}

func (s *Server) handleGetMe(w http.ResponseWriter, r *http.Request) {
	user, err := s.deps.Store.GetUser(r.Context(), userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "server": s.serverInfo()})
}

type patchMeRequest struct {
	DisplayName *string `json:"displayName"`
	Locale      *string `json:"locale"`
	TZ          *string `json:"tz"`
	QuietFrom   *string `json:"quietFrom"`
	QuietTo     *string `json:"quietTo"`
	Airgap      *bool   `json:"airgap"`
}

// handlePatchMe updates settings. Flipping airgap takes effect immediately on the
// notification worker: a privacy switch that needs a restart is not a privacy
// switch (HLD §11).
func (s *Server) handlePatchMe(w http.ResponseWriter, r *http.Request) {
	var req patchMeRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if req.TZ != nil && *req.TZ != "" {
		if _, err := time.LoadLocation(*req.TZ); err != nil {
			s.writeError(w, r, errInvalid("tz: unknown timezone "+*req.TZ))
			return
		}
	}
	for _, hm := range []*string{req.QuietFrom, req.QuietTo} {
		if hm != nil && *hm != "" && !validHM(*hm) {
			s.writeError(w, r, errInvalid("quiet hours must be HH:MM"))
			return
		}
	}

	user, err := s.deps.Store.UpdateUserSettings(r.Context(), userID(r), func(u *domain.User) {
		if req.DisplayName != nil {
			u.DisplayName = strings.TrimSpace(*req.DisplayName)
		}
		if req.Locale != nil {
			u.Locale = *req.Locale
		}
		if req.TZ != nil {
			u.TZ = *req.TZ
		}
		if req.QuietFrom != nil {
			u.QuietFrom = *req.QuietFrom
		}
		if req.QuietTo != nil {
			u.QuietTo = *req.QuietTo
		}
		if req.Airgap != nil {
			u.Airgap = *req.Airgap
		}
	})
	if err != nil {
		s.writeError(w, r, err)
		return
	}

	if req.Airgap != nil && s.deps.Notify != nil {
		s.deps.Notify.SetAirgap(*req.Airgap)
		s.log.InfoContext(r.Context(), "airgap mode changed", "airgap", *req.Airgap, "user", user.ID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "server": s.serverInfo()})
}

// validHM accepts "7:30" as well as "07:30", because a settings field should not
// reject a human typing the obvious thing.
func validHM(v string) bool {
	parts := strings.Split(strings.TrimSpace(v), ":")
	if len(parts) != 2 {
		return false
	}
	h, err := strconv.Atoi(parts[0])
	if err != nil || h < 0 || h > 23 {
		return false
	}
	m, err := strconv.Atoi(parts[1])
	if err != nil || len(parts[1]) != 2 || m < 0 || m > 59 {
		return false
	}
	return true
}

// contextWithTimeout bounds a probe that must not hang behind a wedged
// dependency.
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// ---------------------------------------------------------------- overview

type placeView struct {
	domain.Place
	Stats store.PlaceStats `json:"stats"`
}

type deviceView struct {
	domain.Device
	InsidePlaces []string `json:"insidePlaces"`
}

type overviewResponse struct {
	User    domain.User           `json:"user"`
	Server  serverInfo            `json:"server"`
	People  []connect.Peer        `json:"people"`
	Devices []deviceView          `json:"devices"`
	Places  []placeView           `json:"places"`
	Notes   []domain.Note         `json:"notes"`
	Shares  []domain.Share        `json:"shares"`
	Events  []domain.TriggerEvent `json:"events"`
	Dwells  []domain.PendingDwell `json:"pendingDwells"`
}

// handleOverview is one round trip for the whole control center: the live map's
// rail, the places grid and the notes list all come from here, which keeps the
// first paint to a single request on a phone on 3G (HLD §2.2, "usable on
// Android Go-class over 2G/3G").
func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	uid := userID(r)

	user, err := s.deps.Store.GetUser(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	devices, err := s.deps.Store.ListDevices(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	places, err := s.deps.Store.ListPlaces(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	stats, err := s.deps.Store.PlaceStats(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	notes, err := s.deps.Store.ListNotes(ctx, uid, store.NoteFilter{})
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	shares, err := s.deps.Store.ListShares(ctx, uid, false)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	events, err := s.deps.Store.ListTriggerEvents(ctx, uid, 25)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	dwells, err := s.deps.Store.ListPendingDwells(ctx, uid)
	if err != nil {
		s.writeError(w, r, err)
		return
	}

	// Peers ride along so the live map can draw everyone who is sharing on the
	// first paint, rather than popping in after a second request.
	var people []connect.Peer
	if s.deps.Connect != nil {
		people, err = s.deps.Connect.List(ctx, uid)
		if err != nil {
			s.writeError(w, r, err)
			return
		}
	}

	inside := map[string][]string{}
	if s.deps.Geofence != nil {
		inside = s.deps.Geofence.InsideSnapshot()
	}

	resp := overviewResponse{
		People: people,
		User:   user,
		Server: s.serverInfo(),
		Notes:  notes,
		Shares: shares,
		Events: events,
		Dwells: dwells,
	}
	for _, d := range devices {
		resp.Devices = append(resp.Devices, deviceView{Device: d, InsidePlaces: inside[d.ID]})
	}
	for _, p := range places {
		resp.Places = append(resp.Places, placeView{Place: p, Stats: stats[p.ID]})
	}
	resp.normalize()
	writeJSON(w, http.StatusOK, resp)
}

// normalize replaces nil slices with empty ones.
//
// Go marshals a nil slice as `null`, which is a different type from `[]` to
// every consumer. A brand-new account has nothing in it, so `null` is exactly
// what the *first* request after signing up returns — the one request a client is
// least likely to have been tested against. This turns "an empty workspace" into
// a shape identical to "a workspace with one of everything, minus the contents".
func (r *overviewResponse) normalize() {
	r.People = list(r.People)
	r.Devices = list(r.Devices)
	r.Places = list(r.Places)
	r.Notes = list(r.Notes)
	r.Shares = list(r.Shares)
	r.Events = list(r.Events)
	r.Dwells = list(r.Dwells)
}

func (s *Server) handleListEvents(w http.ResponseWriter, r *http.Request) {
	events, err := s.deps.Store.ListTriggerEvents(r.Context(), userID(r), queryInt(r, "limit", 50))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": list(events)})
}

// ---------------------------------------------------------------- devices

func (s *Server) handleListDevices(w http.ResponseWriter, r *http.Request) {
	devices, err := s.deps.Store.ListDevices(r.Context(), userID(r))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	inside := map[string][]string{}
	if s.deps.Geofence != nil {
		inside = s.deps.Geofence.InsideSnapshot()
	}
	out := make([]deviceView, 0, len(devices))
	for _, d := range devices {
		out = append(out, deviceView{Device: d, InsidePlaces: inside[d.ID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": list(out)})
}

type deviceRequest struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func (s *Server) handleCreateDevice(w http.ResponseWriter, r *http.Request) {
	var req deviceRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		s.writeError(w, r, errInvalid("name is required"))
		return
	}
	if req.Kind == "" {
		req.Kind = "phone"
	}
	dev := domain.Device{
		ID:     req.ID,
		UserID: userID(r),
		Name:   req.Name,
		Kind:   req.Kind,
		Token:  idgen.Token(),
	}
	if dev.ID == "" {
		dev.ID = idgen.New("dev")
	}
	if err := s.deps.Store.UpsertDevice(r.Context(), dev); err != nil {
		s.writeError(w, r, err)
		return
	}
	// The ingest token is returned exactly once, here: it is a credential, so it
	// is never included in a device listing.
	writeJSON(w, http.StatusCreated, map[string]any{
		"device":     dev,
		"pubToken":   dev.Token,
		"pubExample": s.pubExample(dev),
	})
}

func (s *Server) pubExample(dev domain.Device) string {
	return "curl -X POST " + s.deps.Config.PublicBaseURL + "/pub" +
		` -H "Authorization: Bearer ` + dev.Token + `"` +
		` -H "Content-Type: application/json"` +
		` -d '{"_type":"location","lat":12.9716,"lon":77.5946,"tst":` +
		strconv.FormatInt(time.Now().Unix(), 10) + `,"acc":8,"vel":0,"batt":82}'`
}

func (s *Server) handleGetDevice(w http.ResponseWriter, r *http.Request) {
	dev, err := s.deps.Store.GetDevice(r.Context(), userID(r), chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": dev})
}

func (s *Server) handleUpdateDevice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	dev, err := s.deps.Store.GetDevice(r.Context(), userID(r), id)
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	var req deviceRequest
	if err := decodeJSON(r, &req); err != nil {
		s.writeError(w, r, err)
		return
	}
	if n := strings.TrimSpace(req.Name); n != "" {
		dev.Name = n
	}
	if req.Kind != "" {
		dev.Kind = req.Kind
	}
	if err := s.deps.Store.UpsertDevice(r.Context(), dev); err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": dev})
}

func (s *Server) handleDeleteDevice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := s.deps.Store.DeleteDevice(r.Context(), userID(r), id); err != nil {
		s.writeError(w, r, err)
		return
	}
	if s.deps.Geofence != nil {
		s.deps.Geofence.Forget(id)
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleRotateDeviceToken issues a fresh ingest credential and invalidates the
// old one — the "my phone was stolen" button.
func (s *Server) handleRotateDeviceToken(w http.ResponseWriter, r *http.Request) {
	dev, err := s.deps.Store.GetDevice(r.Context(), userID(r), chi.URLParam(r, "id"))
	if err != nil {
		s.writeError(w, r, err)
		return
	}
	dev.Token = idgen.Token()
	if err := s.deps.Store.UpsertDevice(r.Context(), dev); err != nil {
		s.writeError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": dev, "pubToken": dev.Token})
}
