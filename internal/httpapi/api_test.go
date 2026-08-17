package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/ai"
	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/httpapi"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/seed"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/HarshSingh21/locnot/internal/store/memory"
	"github.com/coder/websocket"
)

// stack boots the whole Phase 1 monolith in-process, exactly as cmd/lura wires
// it, and serves it over a real HTTP listener. Integration tests at this level
// are what prove the composition works — the unit tests already cover each
// component's rules.
type stack struct {
	t      *testing.T
	server *httptest.Server
	store  *memory.Store
	bus    *bus.InProcess
	engine *geofence.Engine
	seeded seed.Result
	token  string
	auth   *multiTokenAuth
}

const apiToken = "test-token"

// testPeer is a second account with its own token and device, so a test can act
// as two different people against one server — which is the only honest way to
// test mutual sharing.
type testPeer struct {
	userID string
	// token is the peer's control-plane credential (their session).
	token string
	// deviceToken is what their *device* publishes with — a phone has its own
	// credential, separate from the person's session.
	deviceToken string
	deviceID    string
	email       string
	name        string
}

// multiTokenAuth maps bearer tokens to users. Phase 1 ships a single static
// token; the tests need several, and the Authenticator seam is exactly where
// that swap belongs.
type multiTokenAuth struct {
	mu    sync.RWMutex
	users map[string]string // token -> user id
}

func (m *multiTokenAuth) add(token, userID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.users == nil {
		m.users = map[string]string{}
	}
	m.users[token] = userID
}

func (m *multiTokenAuth) Authenticate(r *http.Request) (auth.Principal, error) {
	token := auth.BearerToken(r)
	if token == "" {
		return auth.Principal{}, fmt.Errorf("missing bearer token: %w", domain.ErrUnauthorized)
	}
	m.mu.RLock()
	userID, ok := m.users[token]
	m.mu.RUnlock()
	if !ok {
		return auth.Principal{}, fmt.Errorf("invalid token: %w", domain.ErrUnauthorized)
	}
	return auth.Principal{Kind: auth.KindUser, UserID: userID}, nil
}

func newStack(t *testing.T) *stack {
	t.Helper()
	ctx := context.Background()

	cfg := config.Default()
	cfg.APIToken = apiToken
	cfg.StoreKind = "memory"
	cfg.AllowedOrigins = []string{"*"}
	// Tight geofence timings so an arrival can be provoked in a test without
	// sleeping for the production debounce.
	cfg.ArriveDebounce = 2 * time.Second
	cfg.ArriveMaxSpeedMPS = 1.5
	cfg.PassbyMinSpeedMPS = 3
	cfg.CoolOff = time.Minute
	cfg.DwellTick = time.Hour
	cfg.EnableTraces, cfg.EnableMetrics, cfg.EnableOTLPLogs, cfg.EnablePrometheus = false, false, false, false

	st := memory.New()
	seeded, err := seed.Run(ctx, st, nil, seed.Options{
		DeviceToken: "device-token", WithHistory: true, WithShares: false,
	})
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	// Quiet hours would suppress push in tests that run at night.
	if _, err := st.UpdateUserSettings(ctx, seeded.User.ID, func(u *domain.User) {
		u.QuietFrom, u.QuietTo = "", ""
	}); err != nil {
		t.Fatalf("clear quiet hours: %v", err)
	}

	b := bus.NewInProcess(nil)
	h, err := hub.New(b, nil)
	if err != nil {
		t.Fatalf("hub: %v", err)
	}

	writer := ingest.NewWriter(st, b, nil, ingest.WriterOptions{BatchSize: 1, FlushEvery: 10 * time.Millisecond})
	if err := writer.Start(ctx); err != nil {
		t.Fatalf("writer: %v", err)
	}

	engine := geofence.New(st, b, gate.NewMemory(), nil, geofence.Config{
		FreshWindow:       cfg.FreshWindow,
		ArriveDebounce:    cfg.ArriveDebounce,
		ArriveMaxSpeedMPS: cfg.ArriveMaxSpeedMPS,
		PassbyMinSpeedMPS: cfg.PassbyMinSpeedMPS,
		CoolOff:           cfg.CoolOff,
		DwellTick:         cfg.DwellTick,
		Partitions:        1,
	})
	if err := engine.Start(ctx); err != nil {
		t.Fatalf("geofence: %v", err)
	}

	notifier := notify.NewWorker(st, b, nil, notify.Config{Tries: 1},
		&notify.InApp{Bus: b}, &notify.Log{})
	if err := notifier.Start(ctx); err != nil {
		t.Fatalf("notify: %v", err)
	}

	shares := share.New(st, b, nil, "")
	shares.Track(seeded.User.ID)
	if err := shares.Start(ctx); err != nil {
		t.Fatalf("shares: %v", err)
	}

	tokens := &multiTokenAuth{}
	tokens.add(apiToken, seed.DemoUserID)

	api := httpapi.New(httpapi.Deps{
		Config:   cfg,
		Store:    st,
		Bus:      b,
		Hub:      h,
		Ingest:   ingest.New(b, nil, cfg.IngestRatePerMin, cfg.IngestBurst),
		Geofence: engine,
		Notify:   notifier,
		Shares:   shares,
		History:  history.New(st, nil, history.Config{}),
		AI:       ai.NewRules(),
		Auth:     tokens,
		Connect:  connect.New(st, b, nil),
		Devices:  &auth.DeviceAuth{Devices: st, APIToken: apiToken, UserID: seed.DemoUserID},
		Version:  "test",
		Started:  time.Now(),
	})

	// The share service is constructed with an empty base URL: the test server's
	// port is only known after it starts, so links are asserted as paths.
	srv := httptest.NewServer(api.Handler())

	t.Cleanup(func() {
		srv.Close()
		shares.Stop()
		notifier.Stop()
		engine.Stop()
		writer.Stop()
		h.Close()
		_ = b.Close()
	})

	return &stack{t: t, server: srv, store: st, bus: b, engine: engine, seeded: seeded, token: apiToken, auth: tokens}
}

// ---------------------------------------------------------------- HTTP helpers

func (s *stack) do(method, path string, body any, authorize bool) *http.Response {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			s.t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, s.server.URL+path, reader)
	if err != nil {
		s.t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if authorize {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := s.server.Client().Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

// json performs a request and decodes the response, asserting the status.
func (s *stack) json(method, path string, body any, wantStatus int) map[string]any {
	s.t.Helper()
	resp := s.do(method, path, body, true)
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		s.t.Fatalf("read body: %v", err)
	}
	if resp.StatusCode != wantStatus {
		s.t.Fatalf("%s %s = %d, want %d: %s", method, path, resp.StatusCode, wantStatus, raw)
	}
	if len(raw) == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		s.t.Fatalf("%s %s: body is not a JSON object: %v: %s", method, path, err, raw)
	}
	return out
}

// jsonAs performs a request as a specific account.
func (s *stack) jsonAs(token, method, path string, body any, wantStatus int) map[string]any {
	s.t.Helper()
	previous := s.token
	s.token = token
	defer func() { s.token = previous }()
	return s.json(method, path, body, wantStatus)
}

// addPeer creates a second account with a device and a token of its own.
func (s *stack) addPeer(t *testing.T, userID, email, name string) testPeer {
	t.Helper()
	ctx := context.Background()
	if err := s.store.UpsertUser(ctx, domain.User{
		ID: userID, Email: email, DisplayName: name, TZ: "UTC", Locale: "en",
	}); err != nil {
		t.Fatalf("create peer user: %v", err)
	}
	deviceID := userID + "_phone"
	if err := s.store.UpsertDevice(ctx, domain.Device{
		ID: deviceID, UserID: userID, Name: name + "'s Phone", Kind: "phone", Token: userID + "-device",
	}); err != nil {
		t.Fatalf("create peer device: %v", err)
	}
	token := userID + "-token"
	s.auth.add(token, userID)
	return testPeer{
		userID: userID, token: token,
		deviceToken: userID + "-device", deviceID: deviceID,
		email: email, name: name,
	}
}

// connectPeers drives a full mutual connection over the API: the demo user
// invites the peer, and the peer accepts as themselves.
func (s *stack) connectPeers(t *testing.T, peer testPeer) {
	t.Helper()
	s.json(http.MethodPost, "/api/v1/people/invite", map[string]any{"email": peer.email}, http.StatusCreated)
	s.jsonAs(peer.token, http.MethodPost, "/api/v1/people/"+seed.DemoUserID+"/accept", nil, http.StatusOK)
}

func (s *stack) status(method, path string, body any) int {
	s.t.Helper()
	resp := s.do(method, path, body, true)
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode
}

// ---------------------------------------------------------------- auth

func TestControlPlaneRequiresAToken(t *testing.T) {
	s := newStack(t)

	for _, path := range []string{"/api/v1/overview", "/api/v1/places", "/api/v1/notes", "/api/v1/shares"} {
		resp := s.do(http.MethodGet, path, nil, false)
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Errorf("GET %s without a token = %d, want 401", path, resp.StatusCode)
		}
		if resp.Header.Get("WWW-Authenticate") == "" {
			t.Errorf("GET %s: no WWW-Authenticate header on a 401", path)
		}
	}

	// A wrong token is 401, not 500.
	req, _ := http.NewRequest(http.MethodGet, s.server.URL+"/api/v1/overview", nil)
	req.Header.Set("Authorization", "Bearer nope")
	resp, err := s.server.Client().Do(req)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("wrong token = %d, want 401", resp.StatusCode)
	}
}

// ---------------------------------------------------------------- overview

// TestOverviewOfAnEmptyWorkspaceIsAllArrays guards the very first request a new
// account makes. Go marshals a nil slice as `null`, and a client that reads
// `data.shares.length` crashes on it — which is exactly what happened: the People
// screen was a white page for anyone who had not created anything yet.
func TestOverviewOfAnEmptyWorkspaceIsAllArrays(t *testing.T) {
	s := newStack(t)
	newcomer := s.addPeer(t, "usr_newcomer", "newcomer@lura.local", "Newcomer")

	body := s.jsonAs(newcomer.token, http.MethodGet, "/api/v1/overview", nil, http.StatusOK)

	for _, key := range []string{"people", "devices", "places", "notes", "shares", "events", "pendingDwells"} {
		value, ok := body[key]
		if !ok {
			t.Errorf("overview is missing %q", key)
			continue
		}
		if _, isArray := value.([]any); !isArray {
			t.Errorf("overview[%q] = %v (%T), want a JSON array", key, value, value)
		}
	}
}

func TestOverviewReturnsTheWholeWorkspace(t *testing.T) {
	s := newStack(t)
	body := s.json(http.MethodGet, "/api/v1/overview", nil, http.StatusOK)

	for _, key := range []string{"user", "server", "devices", "places", "notes", "shares", "events"} {
		if _, ok := body[key]; !ok {
			t.Errorf("overview is missing %q", key)
		}
	}
	if devices, _ := body["devices"].([]any); len(devices) != 2 {
		t.Errorf("devices = %d, want 2", len(devices))
	}
	if places, _ := body["places"].([]any); len(places) != 6 {
		t.Errorf("places = %d, want 6", len(places))
	}

	// The server block tells the client what this deployment can do.
	server, _ := body["server"].(map[string]any)
	if server["mapStyleUrl"] == "" || server["phase"] != "1" {
		t.Errorf("server info = %+v", server)
	}

	// Place stats back the counters in the places grid.
	places, _ := body["places"].([]any)
	first, _ := places[0].(map[string]any)
	if _, ok := first["stats"]; !ok {
		t.Error("place is missing its stats block")
	}
}

// ---------------------------------------------------------------- places

func TestPlaceCRUDAndValidation(t *testing.T) {
	s := newStack(t)

	created := s.json(http.MethodPost, "/api/v1/places", map[string]any{
		"name":     "Coffee",
		"tags":     []string{"Food", "food", " CAFE "},
		"center":   map[string]float64{"lat": 12.97, "lon": 77.63},
		"radiusM":  80,
		"triggers": []string{"arrive", "passby"},
	}, http.StatusCreated)

	place, _ := created["place"].(map[string]any)
	id, _ := place["id"].(string)
	if id == "" {
		t.Fatal("created place has no id")
	}
	// Tags are normalised: lowercased, trimmed, de-duplicated.
	tags, _ := place["tags"].([]any)
	if len(tags) != 2 {
		t.Errorf("tags = %v, want 2 after normalisation", tags)
	}

	// A patch touching one field leaves the rest alone.
	patched := s.json(http.MethodPatch, "/api/v1/places/"+id, map[string]any{"radiusM": 150}, http.StatusOK)
	place, _ = patched["place"].(map[string]any)
	if place["radiusM"].(float64) != 150 {
		t.Errorf("radiusM = %v, want 150", place["radiusM"])
	}
	if place["name"] != "Coffee" {
		t.Errorf("name changed on a radius patch: %v", place["name"])
	}

	cases := []struct {
		name string
		body map[string]any
	}{
		{"no name", map[string]any{"center": map[string]float64{"lat": 12.9, "lon": 77.6}, "radiusM": 100}},
		{"radius too small", map[string]any{"name": "x", "center": map[string]float64{"lat": 12.9, "lon": 77.6}, "radiusM": 5}},
		{"radius too large", map[string]any{"name": "x", "center": map[string]float64{"lat": 12.9, "lon": 77.6}, "radiusM": 99999}},
		{"null island", map[string]any{"name": "x", "center": map[string]float64{"lat": 0, "lon": 0}, "radiusM": 100}},
		{"unknown trigger", map[string]any{"name": "x", "center": map[string]float64{"lat": 12.9, "lon": 77.6}, "radiusM": 100, "triggers": []string{"teleport"}}},
		{"unknown field", map[string]any{"name": "x", "centre": map[string]float64{"lat": 12.9, "lon": 77.6}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := s.status(http.MethodPost, "/api/v1/places", tc.body); got != http.StatusBadRequest {
				t.Errorf("POST /places (%s) = %d, want 400", tc.name, got)
			}
		})
	}

	if got := s.status(http.MethodDelete, "/api/v1/places/"+id, nil); got != http.StatusNoContent {
		t.Errorf("DELETE = %d, want 204", got)
	}
	if got := s.status(http.MethodGet, "/api/v1/places/"+id, nil); got != http.StatusNotFound {
		t.Errorf("GET after delete = %d, want 404", got)
	}
}

// ---------------------------------------------------------------- notes

// Creating a note from free text binds it to a place via the AI Brain and returns
// the suggestion, which is the flow HLD §7.3 describes.
func TestCreateNoteAppliesSuggestion(t *testing.T) {
	s := newStack(t)

	body := s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text": "buy oat milk when I pass the store",
	}, http.StatusCreated)

	note, _ := body["note"].(map[string]any)
	if note["placeId"] != "plc_grocery" {
		t.Errorf("placeId = %v, want plc_grocery", note["placeId"])
	}
	if note["trigger"] != "passby" {
		t.Errorf("trigger = %v, want passby", note["trigger"])
	}
	suggestion, ok := body["suggestion"].(map[string]any)
	if !ok {
		t.Fatal("response has no suggestion block")
	}
	if suggestion["engine"] != "rules" || suggestion["onDevice"] != true {
		t.Errorf("suggestion = %+v", suggestion)
	}

	// An explicit choice must win over the model.
	body = s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text":    "buy oat milk when I pass the store",
		"placeId": "plc_home",
		"trigger": "arrive",
	}, http.StatusCreated)
	note, _ = body["note"].(map[string]any)
	if note["placeId"] != "plc_home" || note["trigger"] != "arrive" {
		t.Errorf("explicit fields were overridden: %+v", note)
	}

	// The composer's preview endpoint returns a suggestion without creating a note.
	before := len(s.listNotes(t))
	preview := s.json(http.MethodPost, "/api/v1/notes/suggest", map[string]any{
		"text": "return the library books on the way",
	}, http.StatusOK)
	sug, _ := preview["suggestion"].(map[string]any)
	if sug["placeId"] != "plc_library" {
		t.Errorf("preview suggestion = %+v", sug)
	}
	if after := len(s.listNotes(t)); after != before {
		t.Errorf("the preview created a note: %d → %d", before, after)
	}

	if got := s.status(http.MethodPost, "/api/v1/notes", map[string]any{"text": "  "}); got != http.StatusBadRequest {
		t.Errorf("empty text = %d, want 400", got)
	}
}

func (s *stack) listNotes(t *testing.T) []any {
	t.Helper()
	body := s.json(http.MethodGet, "/api/v1/notes", nil, http.StatusOK)
	notes, _ := body["notes"].([]any)
	return notes
}

// Binding a note to a place whose trigger is not armed must arm it, so the
// reminder can actually fire.
func TestNoteArmsItsPlacesTrigger(t *testing.T) {
	s := newStack(t)

	// The Gym is seeded with dwell only.
	body := s.json(http.MethodPost, "/api/v1/notes", map[string]any{
		"text":    "bring the resistance band",
		"placeId": "plc_gym",
		"trigger": "arrive",
	}, http.StatusCreated)
	if note, _ := body["note"].(map[string]any); note["trigger"] != "arrive" {
		t.Fatalf("note trigger = %v", note["trigger"])
	}

	place := s.json(http.MethodGet, "/api/v1/places/plc_gym", nil, http.StatusOK)
	triggers, _ := place["place"].(map[string]any)["triggers"].([]any)
	found := false
	for _, tr := range triggers {
		if tr == "arrive" {
			found = true
		}
	}
	if !found {
		t.Errorf("place triggers = %v, want arrive to have been armed", triggers)
	}
}

func TestNoteDoneToggleAndDelete(t *testing.T) {
	s := newStack(t)
	notes := s.listNotes(t)
	if len(notes) == 0 {
		t.Fatal("no seeded notes")
	}
	first, _ := notes[0].(map[string]any)
	id, _ := first["id"].(string)

	updated := s.json(http.MethodPatch, "/api/v1/notes/"+id, map[string]any{"done": true}, http.StatusOK)
	if note, _ := updated["note"].(map[string]any); note["done"] != true {
		t.Errorf("done = %v, want true", note["done"])
	}
	if got := s.status(http.MethodDelete, "/api/v1/notes/"+id, nil); got != http.StatusNoContent {
		t.Errorf("DELETE = %d, want 204", got)
	}
	if got := s.status(http.MethodGet, "/api/v1/notes/"+id, nil); got != http.StatusNotFound {
		t.Errorf("GET after delete = %d, want 404", got)
	}
}

// ---------------------------------------------------------------- ingest

func TestPubRequiresDeviceCredentials(t *testing.T) {
	s := newStack(t)

	resp := s.do(http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": 12.96, "lon": 77.63,
	}, false)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("POST /pub without credentials = %d, want 401", resp.StatusCode)
	}

	// The device's own token works without naming the device.
	req, _ := http.NewRequest(http.MethodPost, s.server.URL+"/pub",
		strings.NewReader(`{"_type":"location","lat":12.96,"lon":77.63,"speedMps":1}`))
	req.Header.Set("Authorization", "Bearer device-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.server.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /pub: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /pub with a device token = %d: %s", resp.StatusCode, raw)
	}
}

// An OwnTracks client must get the empty JSON array it expects, while Lura's own
// clients get the stored position echoed back.
func TestPubResponseShapeFollowsTheClient(t *testing.T) {
	s := newStack(t)

	// OwnTracks-shaped request.
	req, _ := http.NewRequest(http.MethodPost, s.server.URL+"/pub?device=dev_phone",
		strings.NewReader(`{"_type":"location","lat":12.96,"lon":77.63,"tid":"ph","tst":1770000000}`))
	req.Header.Set("Authorization", "Bearer "+apiToken)
	req.Header.Set("User-Agent", "OwnTracks/2.4.9")
	resp, err := s.server.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /pub: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if strings.TrimSpace(string(raw)) != "[]" {
		t.Errorf("OwnTracks response = %s, want []", raw)
	}

	// Lura-shaped request.
	body := s.pub(t, 12.96, 77.63, 1)
	if body["status"] != "ok" {
		t.Errorf("response = %+v, want status ok", body)
	}
	if _, ok := body["position"]; !ok {
		t.Error("response has no position echo")
	}
}

func (s *stack) pub(t *testing.T, lat, lon, speed float64) map[string]any {
	t.Helper()
	payload := map[string]any{
		"_type": "location", "lat": lat, "lon": lon, "speedMps": speed,
		"tst": time.Now().Unix(), "acc": 5, "batt": 80,
	}
	return s.json(http.MethodPost, "/pub?device=dev_phone", payload, http.StatusOK)
}

func TestPubRejectsBadPayloads(t *testing.T) {
	s := newStack(t)
	cases := []struct {
		name string
		body map[string]any
	}{
		{"null island", map[string]any{"_type": "location", "lat": 0, "lon": 0}},
		{"out of range", map[string]any{"_type": "location", "lat": 200, "lon": 77}},
		{"wrong type", map[string]any{"_type": "transition", "lat": 12.9, "lon": 77.6}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := s.status(http.MethodPost, "/pub?device=dev_phone", tc.body); got != http.StatusBadRequest {
				t.Errorf("= %d, want 400", got)
			}
		})
	}
}

// ---------------------------------------------------------------- live socket

// dialWS opens the authenticated live socket. Browsers cannot set headers on a
// WebSocket, which is why the token may travel as a query parameter.
func (s *stack) dialWS(t *testing.T, path string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(s.server.URL, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	return conn
}

// nextFrame reads until a frame of the wanted type arrives.
func nextFrame(t *testing.T, conn *websocket.Conn, want string, timeout time.Duration) hub.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for a %q frame: %v", want, err)
		}
		var f hub.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("undecodable frame: %v", err)
		}
		if f.Type == want {
			return f
		}
	}
}

func TestWebSocketPushesLivePositions(t *testing.T) {
	s := newStack(t)
	conn := s.dialWS(t, "/ws?access_token="+apiToken)

	// hello, then a snapshot so the map can paint before the first live fix.
	nextFrame(t, conn, hub.FrameHello, 3*time.Second)
	snapshot := nextFrame(t, conn, "snapshot", 3*time.Second)
	var snap struct {
		Devices []map[string]any `json:"devices"`
		Places  []map[string]any `json:"places"`
	}
	if err := json.Unmarshal(snapshot.Data, &snap); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	if len(snap.Devices) != 2 || len(snap.Places) != 6 {
		t.Errorf("snapshot has %d devices and %d places", len(snap.Devices), len(snap.Places))
	}

	// A fix posted to /pub must arrive on the socket.
	s.pub(t, 12.9500, 77.6300, 4)
	frame := nextFrame(t, conn, hub.FramePosition, 3*time.Second)
	var pos domain.Position
	if err := json.Unmarshal(frame.Data, &pos); err != nil {
		t.Fatalf("position frame: %v", err)
	}
	if pos.DeviceID != "dev_phone" {
		t.Errorf("device = %q, want dev_phone", pos.DeviceID)
	}
	if pos.SpeedMPS != 4 {
		t.Errorf("speed = %v, want 4", pos.SpeedMPS)
	}

	// An application-level ping is answered: browsers cannot send control pings.
	writeCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageText, []byte(`{"type":"ping"}`)); err != nil {
		t.Fatalf("write ping: %v", err)
	}
	nextFrame(t, conn, hub.FramePong, 3*time.Second)
}

// The whole reminder chain over HTTP: a fix that enters a fence at walking pace
// produces a geo event and an in-app reminder on the socket.
func TestArriveFiresGeoEventAndReminder(t *testing.T) {
	s := newStack(t)
	conn := s.dialWS(t, "/ws?access_token="+apiToken)
	nextFrame(t, conn, hub.FrameHello, 3*time.Second)

	// Start outside Home so the fix below is an entry, then arrive slowly.
	s.pub(t, 12.9700, 77.6500, 8)
	s.pub(t, 12.9611, 77.6387, 0.4)

	geoFrame := nextFrame(t, conn, hub.FrameGeo, 5*time.Second)
	var ev domain.GeoEvent
	if err := json.Unmarshal(geoFrame.Data, &ev); err != nil {
		t.Fatalf("geo frame: %v", err)
	}
	if ev.Trigger != domain.TriggerArrive || ev.PlaceName != "Home" {
		t.Fatalf("geo event = %+v, want an arrive at Home", ev)
	}

	notifyFrame := nextFrame(t, conn, hub.FrameNotify, 5*time.Second)
	var msg notify.Message
	if err := json.Unmarshal(notifyFrame.Data, &msg); err != nil {
		t.Fatalf("notify frame: %v", err)
	}
	if !strings.Contains(msg.Body, "landlord") {
		t.Errorf("reminder body = %q, want the seeded Home arrive note", msg.Body)
	}

	// And it lands in the trigger history.
	deadline := time.Now().Add(3 * time.Second)
	for {
		events := s.json(http.MethodGet, "/api/v1/events", nil, http.StatusOK)
		list, _ := events["events"].([]any)
		if len(list) > 0 {
			first, _ := list[0].(map[string]any)
			if first["trigger"] != "arrive" {
				t.Errorf("recorded event = %+v", first)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no trigger event was recorded")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- sharing

func TestShareLifecycle(t *testing.T) {
	s := newStack(t)

	created := s.json(http.MethodPost, "/api/v1/shares", map[string]any{
		"label": "Priya", "mode": "duration", "durationMins": 120,
	}, http.StatusCreated)
	sh, _ := created["share"].(map[string]any)
	token, _ := sh["token"].(string)
	id, _ := sh["id"].(string)
	if token == "" || id == "" {
		t.Fatalf("share = %+v", sh)
	}
	if sh["link"] == "" {
		t.Error("share has no link")
	}

	// The public view needs no credentials and shows only what a recipient needs.
	resp := s.do(http.MethodGet, "/s/"+token, nil, false)
	raw, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("public view = %d: %s", resp.StatusCode, raw)
	}
	var view share.PublicView
	if err := json.Unmarshal(raw, &view); err != nil {
		t.Fatalf("public view: %v", err)
	}
	if view.SharerName != "Aravind" || len(view.Devices) != 2 {
		t.Errorf("public view = %+v", view)
	}
	if strings.Contains(string(raw), "landlord") {
		t.Error("the public share view leaked note text")
	}
	if cc := resp.Header.Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store for a live position", cc)
	}

	// The recipient needs a basemap and nothing else about the deployment. Without
	// the style URL they get markers on blank ground, which is indistinguishable
	// from a broken link; with the rest of the server block, an endpoint anyone
	// with a link can call would fingerprint the install.
	var envelope struct {
		Map map[string]any `json:"map"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("public view envelope: %v", err)
	}
	if envelope.Map["styleUrl"] == "" || envelope.Map["styleUrl"] == nil {
		t.Errorf("public view carries no map style URL: %v", envelope.Map)
	}
	for _, leaked := range []string{"version", "store", "aiEngine", "publicBaseUrl"} {
		if _, present := envelope.Map[leaked]; present {
			t.Errorf("the public share view exposes %q", leaked)
		}
	}

	// A share viewer's socket receives positions…
	conn := s.dialWS(t, "/s/"+token+"/ws")
	nextFrame(t, conn, hub.FrameHello, 3*time.Second)
	s.pub(t, 12.9450, 77.6250, 6)
	nextFrame(t, conn, hub.FramePosition, 5*time.Second)

	// …and stops the moment the share is revoked (HLD §5.1 ACL re-subscription).
	s.json(http.MethodDelete, "/api/v1/shares/"+id, nil, http.StatusOK)
	nextFrame(t, conn, hub.FrameACL, 5*time.Second)

	drained := drainFor(t, conn, 400*time.Millisecond)
	for _, f := range drained {
		if f.Type == hub.FramePosition {
			t.Fatal("a revoked share viewer still received a position")
		}
	}
	s.pub(t, 12.9400, 77.6200, 6)
	for _, f := range drainFor(t, conn, 500*time.Millisecond) {
		if f.Type == hub.FramePosition {
			t.Fatal("a revoked share viewer received a position published after the revoke")
		}
	}

	// The public view is now forbidden.
	resp = s.do(http.MethodGet, "/s/"+token, nil, false)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("revoked public view = %d, want 403", resp.StatusCode)
	}

	// An unknown token is a 404, and must not hint at whether it ever existed.
	resp = s.do(http.MethodGet, "/s/definitely-not-a-token", nil, false)
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("unknown token = %d, want 404", resp.StatusCode)
	}
}

// drainFor collects whatever frames arrive within d.
func drainFor(t *testing.T, conn *websocket.Conn, d time.Duration) []hub.Frame {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	var out []hub.Frame
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return out
		}
		var f hub.Frame
		if err := json.Unmarshal(data, &f); err == nil {
			out = append(out, f)
		}
	}
}

func TestShareValidation(t *testing.T) {
	s := newStack(t)
	cases := []struct {
		name string
		body map[string]any
	}{
		{"duration mode without a duration", map[string]any{"mode": "duration"}},
		{"until-arrive without a place", map[string]any{"mode": "until_arrive"}},
		{"unknown place", map[string]any{"mode": "until_arrive", "arrivePlaceId": "plc_nope"}},
		{"unknown mode", map[string]any{"mode": "forever"}},
		{"absurd duration", map[string]any{"mode": "duration", "durationMins": 60 * 24 * 60}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := s.status(http.MethodPost, "/api/v1/shares", tc.body)
			if got != http.StatusBadRequest && got != http.StatusNotFound {
				t.Errorf("= %d, want 400 or 404", got)
			}
		})
	}
}

// ---------------------------------------------------------------- history

func TestHistoryAndExports(t *testing.T) {
	s := newStack(t)

	body := s.json(http.MethodGet, "/api/v1/history?deviceId=dev_phone&from=-24h", nil, http.StatusOK)
	if body["points"].(float64) == 0 {
		t.Fatal("seeded history is empty")
	}
	if body["trips"].(float64) == 0 {
		t.Error("no trips were derived from the seeded day")
	}
	segments, _ := body["segments"].([]any)
	if len(segments) == 0 {
		t.Fatal("no segments")
	}

	for _, tc := range []struct{ format, contentType, marker string }{
		{"geojson", "application/geo+json", `"FeatureCollection"`},
		{"gpx", "application/gpx+xml", "<gpx"},
	} {
		t.Run(tc.format, func(t *testing.T) {
			resp := s.do(http.MethodGet, "/api/v1/history/export?deviceId=dev_phone&from=-24h&format="+tc.format, nil, true)
			defer resp.Body.Close()
			raw, _ := io.ReadAll(resp.Body)
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("export = %d: %s", resp.StatusCode, raw)
			}
			if ct := resp.Header.Get("Content-Type"); ct != tc.contentType {
				t.Errorf("Content-Type = %q, want %q", ct, tc.contentType)
			}
			if cd := resp.Header.Get("Content-Disposition"); !strings.Contains(cd, "attachment") {
				t.Errorf("Content-Disposition = %q, want an attachment", cd)
			}
			if !strings.Contains(string(raw), tc.marker) {
				t.Errorf("export body does not look like %s: %.80s", tc.format, raw)
			}
		})
	}

	if got := s.status(http.MethodGet, "/api/v1/history/export?format=csv", nil); got != http.StatusBadRequest {
		t.Errorf("unknown export format = %d, want 400", got)
	}
	if got := s.status(http.MethodGet, "/api/v1/history?from=nonsense", nil); got != http.StatusBadRequest {
		t.Errorf("bad timestamp = %d, want 400", got)
	}

	// Deleting everything must be explicit.
	if got := s.status(http.MethodDelete, "/api/v1/history", nil); got != http.StatusBadRequest {
		t.Errorf("DELETE /history with no bounds = %d, want 400", got)
	}
	deleted := s.json(http.MethodDelete, "/api/v1/history?all=true", nil, http.StatusOK)
	if deleted["deleted"].(float64) == 0 {
		t.Error("DELETE /history?all=true removed nothing")
	}
}

// ---------------------------------------------------------------- settings

func TestAirgapToggleAndQuietHours(t *testing.T) {
	s := newStack(t)

	body := s.json(http.MethodPatch, "/api/v1/me", map[string]any{"airgap": true}, http.StatusOK)
	user, _ := body["user"].(map[string]any)
	if user["airgap"] != true {
		t.Errorf("airgap = %v, want true", user["airgap"])
	}

	body = s.json(http.MethodPatch, "/api/v1/me", map[string]any{
		"quietFrom": "22:30", "quietTo": "7:00", "tz": "Asia/Kolkata",
	}, http.StatusOK)
	user, _ = body["user"].(map[string]any)
	if user["quietFrom"] != "22:30" || user["tz"] != "Asia/Kolkata" {
		t.Errorf("settings = %+v", user)
	}

	for _, bad := range []map[string]any{
		{"tz": "Mars/Olympus"},
		{"quietFrom": "25:00"},
		{"quietTo": "7"},
	} {
		if got := s.status(http.MethodPatch, "/api/v1/me", bad); got != http.StatusBadRequest {
			t.Errorf("PATCH /me %v = %d, want 400", bad, got)
		}
	}
}

// In airgap mode, the suggester must be the local one whatever else is configured.
func TestAirgapKeepsSuggestionsLocal(t *testing.T) {
	s := newStack(t)
	s.json(http.MethodPatch, "/api/v1/me", map[string]any{"airgap": true}, http.StatusOK)

	body := s.json(http.MethodPost, "/api/v1/notes/suggest", map[string]any{
		"text": "buy oat milk when I pass the store",
	}, http.StatusOK)
	sug, _ := body["suggestion"].(map[string]any)
	if sug["engine"] != "rules" || sug["onDevice"] != true {
		t.Errorf("suggestion in airgap mode = %+v", sug)
	}
}

// ---------------------------------------------------------------- channels, ops

func TestChannelCRUD(t *testing.T) {
	s := newStack(t)

	created := s.json(http.MethodPost, "/api/v1/channels", map[string]any{
		"type": "ntfy", "config": map[string]string{"topic": "lura-me"}, "priority": 5,
	}, http.StatusCreated)
	ch, _ := created["channel"].(map[string]any)
	id, _ := ch["id"].(string)

	if got := s.status(http.MethodPost, "/api/v1/channels", map[string]any{"type": "carrier-pigeon"}); got != http.StatusBadRequest {
		t.Errorf("unknown channel type = %d, want 400", got)
	}

	updated := s.json(http.MethodPatch, "/api/v1/channels/"+id, map[string]any{"enabled": false}, http.StatusOK)
	if chan2, _ := updated["channel"].(map[string]any); chan2["enabled"] != false {
		t.Errorf("enabled = %v, want false", chan2["enabled"])
	}
	if got := s.status(http.MethodDelete, "/api/v1/channels/"+id, nil); got != http.StatusNoContent {
		t.Errorf("DELETE = %d, want 204", got)
	}
	if got := s.status(http.MethodPatch, "/api/v1/channels/"+id, map[string]any{"enabled": true}); got != http.StatusNotFound {
		t.Errorf("PATCH after delete = %d, want 404", got)
	}
}

func TestDeviceTokenRotation(t *testing.T) {
	s := newStack(t)

	created := s.json(http.MethodPost, "/api/v1/devices", map[string]any{"name": "Tracker", "kind": "tracker"}, http.StatusCreated)
	id, _ := created["device"].(map[string]any)["id"].(string)
	first, _ := created["pubToken"].(string)
	if first == "" {
		t.Fatal("no ingest token was issued")
	}

	// A device listing must never include credentials.
	list := s.json(http.MethodGet, "/api/v1/devices", nil, http.StatusOK)
	if strings.Contains(fmt.Sprint(list), first) {
		t.Error("the device listing leaked an ingest token")
	}

	rotated := s.json(http.MethodPost, "/api/v1/devices/"+id+"/token", nil, http.StatusOK)
	second, _ := rotated["pubToken"].(string)
	if second == "" || second == first {
		t.Fatal("the token was not rotated")
	}

	// The old credential must stop working.
	req, _ := http.NewRequest(http.MethodPost, s.server.URL+"/pub",
		strings.NewReader(`{"_type":"location","lat":12.96,"lon":77.63}`))
	req.Header.Set("Authorization", "Bearer "+first)
	resp, err := s.server.Client().Do(req)
	if err != nil {
		t.Fatalf("POST /pub: %v", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("the rotated-out token still works: %d", resp.StatusCode)
	}
}

func TestOpsEndpoints(t *testing.T) {
	s := newStack(t)

	health := s.json(http.MethodGet, "/healthz", nil, http.StatusOK)
	if health["status"] != "ok" || health["store"] != "memory" {
		t.Errorf("healthz = %+v", health)
	}
	ready := s.json(http.MethodGet, "/readyz", nil, http.StatusOK)
	if ready["status"] != "ready" {
		t.Errorf("readyz = %+v", ready)
	}
	version := s.json(http.MethodGet, "/version", nil, http.StatusOK)
	if version["version"] != "test" {
		t.Errorf("version = %+v", version)
	}
}

// CORS must let the Expo dev server (a different origin) call the API, including
// the preflight.
func TestCORSPreflight(t *testing.T) {
	s := newStack(t)

	req, _ := http.NewRequest(http.MethodOptions, s.server.URL+"/api/v1/overview", nil)
	req.Header.Set("Origin", "http://localhost:8081")
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := s.server.Client().Do(req)
	if err != nil {
		t.Fatalf("preflight: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("preflight = %d, want 204", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "http://localhost:8081" {
		t.Errorf("Allow-Origin = %q", resp.Header.Get("Access-Control-Allow-Origin"))
	}
	if !strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Errorf("Allow-Headers = %q, want Authorization", resp.Header.Get("Access-Control-Allow-Headers"))
	}
}
