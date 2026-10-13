package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/ai"
	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/httpapi"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/ingest"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
	"github.com/HarshSingh21/locnot/internal/store/postgres"
	"github.com/coder/websocket"
)

// The fence scenarios run the whole server — HTTP API, ingest, geofence
// engine, notify worker, WebSocket hub — against either store, and drive it as
// two real people would: Harsh and Nishtha, each with a session token and a
// phone that publishes with its own device token. Every assertion is about
// what one of them receives on their socket, or must not.

// fenceStack is one running server for a fence scenario.
type fenceStack struct {
	t      *testing.T
	kind   string
	server *httptest.Server
	store  store.Store
	engine *geofence.Engine
	auth   *multiTokenAuth
	// clock is the engine's and the cool-off gate's clock: real time plus an
	// offset a test can move forward, so a dwell can mature without sleeping.
	clock *fenceClock
	cfg   config.Config
}

// fencePerson is one account with a session token and a phone.
type fencePerson struct {
	userID, name, email string
	token               string
	deviceID            string
	deviceToken         string
}

type fenceClock struct{ offset atomic.Int64 }

func (c *fenceClock) now() time.Time { return time.Now().Add(time.Duration(c.offset.Load())) }

func (c *fenceClock) advance(d time.Duration) { c.offset.Add(int64(d)) }

// fenceTune adjusts a scenario's configuration before the stack starts.
type fenceTune func(*config.Config)

// forEachFenceStore runs a scenario on the memory store and, when
// LURA_TEST_DATABASE_URL is set, on PostgreSQL+PostGIS in a schema of its own.
func forEachFenceStore(t *testing.T, tune fenceTune, run func(t *testing.T, s *fenceStack)) {
	t.Helper()
	t.Run("memory", func(t *testing.T) {
		run(t, newFenceStack(t, "memory", tune))
	})
	t.Run("postgres", func(t *testing.T) {
		if os.Getenv("LURA_TEST_DATABASE_URL") == "" {
			t.Skip("set LURA_TEST_DATABASE_URL to run the fence scenarios on PostgreSQL")
		}
		run(t, newFenceStack(t, "postgres", tune))
	})
}

var fenceSchemaSeq atomic.Int64

// openFencePostgres opens a migrated store in a fresh schema that is dropped
// when the test ends.
func openFencePostgres(t *testing.T) store.Store {
	t.Helper()
	dsn := os.Getenv("LURA_TEST_DATABASE_URL")
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("lura_fences_%d_%d", time.Now().UnixNano()%1e9, fenceSchemaSeq.Add(1))

	bootstrap, err := postgres.Open(ctx, dsn, nil)
	if err != nil {
		t.Fatalf("open bootstrap connection: %v", err)
	}
	if _, err := bootstrap.Pool().Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = bootstrap.Close()
		t.Fatalf("create schema: %v", err)
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	st, err := postgres.Open(ctx, dsn+sep+"search_path="+schema+",public", nil)
	if err != nil {
		_ = bootstrap.Close()
		t.Fatalf("open test connection: %v", err)
	}
	if err := st.Migrate(ctx); err != nil {
		_ = st.Close()
		_ = bootstrap.Close()
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		_ = st.Close()
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dropCancel()
		if _, err := bootstrap.Pool().Exec(dropCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
		_ = bootstrap.Close()
	})
	return st
}

func newFenceStack(t *testing.T, kind string, tune fenceTune) *fenceStack {
	t.Helper()
	ctx := context.Background()

	cfg := config.Default()
	cfg.APIToken = "fence-api-token"
	cfg.StoreKind = kind
	cfg.AllowedOrigins = []string{"*"}
	cfg.ArriveDebounce = 2 * time.Second
	cfg.ArriveMaxSpeedMPS = 1.5
	cfg.PassbyMinSpeedMPS = 3
	cfg.LeaveMarginM = 20
	cfg.CoolOff = time.Minute
	cfg.DwellTick = 50 * time.Millisecond
	cfg.IngestRatePerMin, cfg.IngestBurst = 6000, 600
	cfg.EnableTraces, cfg.EnableMetrics, cfg.EnableOTLPLogs, cfg.EnablePrometheus = false, false, false, false
	if tune != nil {
		tune(&cfg)
	}

	var st store.Store
	if kind == "postgres" {
		st = openFencePostgres(t)
	} else {
		st = memory.New()
	}

	clock := &fenceClock{}
	b := bus.NewInProcess(nil)
	h, err := hub.New(b, nil)
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	writer := ingest.NewWriter(st, b, nil, ingest.WriterOptions{BatchSize: 1, FlushEvery: 10 * time.Millisecond})
	if err := writer.Start(ctx); err != nil {
		t.Fatalf("writer: %v", err)
	}
	// Wired exactly as cmd/lura wires it, LeaveMarginM included.
	engine := geofence.New(st, b, gate.NewMemory().WithClock(clock.now), nil, geofence.Config{
		FreshWindow:       cfg.FreshWindow,
		ArriveDebounce:    cfg.ArriveDebounce,
		ArriveMaxSpeedMPS: cfg.ArriveMaxSpeedMPS,
		PassbyMinSpeedMPS: cfg.PassbyMinSpeedMPS,
		LeaveMarginM:      cfg.LeaveMarginM,
		CoolOff:           cfg.CoolOff,
		DwellTick:         cfg.DwellTick,
		Partitions:        1,
	}).WithClock(clock.now)
	if err := engine.Start(ctx); err != nil {
		t.Fatalf("geofence: %v", err)
	}
	notifier := notify.NewWorker(st, b, nil, notify.Config{Tries: 1}, &notify.InApp{Bus: b}, &notify.Log{})
	if err := notifier.Start(ctx); err != nil {
		t.Fatalf("notify: %v", err)
	}
	shares := share.New(st, b, nil, "")
	if err := shares.Start(ctx); err != nil {
		t.Fatalf("shares: %v", err)
	}

	tokens := &multiTokenAuth{}
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
		Devices:  &auth.DeviceAuth{Devices: st, APIToken: cfg.APIToken},
		Version:  "test",
		Started:  time.Now(),
	})
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
	return &fenceStack{t: t, kind: kind, server: srv, store: st, engine: engine, auth: tokens, clock: clock, cfg: cfg}
}

// person creates an account with one phone.
func (s *fenceStack) person(name string) fencePerson {
	s.t.Helper()
	id := "usr_" + strings.ToLower(name)
	if err := s.store.UpsertUser(context.Background(), domain.User{
		ID: id, Email: strings.ToLower(name) + "@lura.local", DisplayName: name, TZ: "UTC", Locale: "en",
	}); err != nil {
		s.t.Fatalf("create %s: %v", name, err)
	}
	p := fencePerson{userID: id, name: name, email: strings.ToLower(name) + "@lura.local", token: id + "-session"}
	s.auth.add(p.token, id)
	return s.phone(p, "phone")
}

// phone gives a person another device, returned as a copy of the person that
// publishes from it.
func (s *fenceStack) phone(p fencePerson, suffix string) fencePerson {
	s.t.Helper()
	p.deviceID = p.userID + "_" + suffix
	p.deviceToken = p.deviceID + "-device"
	if err := s.store.UpsertDevice(context.Background(), domain.Device{
		ID: p.deviceID, UserID: p.userID, Name: p.name + "'s " + suffix, Kind: "phone", Token: p.deviceToken,
	}); err != nil {
		s.t.Fatalf("create device for %s: %v", p.name, err)
	}
	return p
}

// connect has a invite b and b accept, over the API.
func (s *fenceStack) connect(a, b fencePerson) {
	s.t.Helper()
	s.call(a.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": b.email}, http.StatusCreated)
	s.call(b.token, http.MethodPost, "/api/v1/people/"+a.userID+"/accept", nil, http.StatusOK)
}

// setSharing flips who's sharing toward peer.
func (s *fenceStack) setSharing(who, peer fencePerson, on bool) {
	s.t.Helper()
	s.call(who.token, http.MethodPatch, "/api/v1/people/"+peer.userID, map[string]any{"sharing": on}, http.StatusOK)
}

func (s *fenceStack) request(token, method, path string, body any) (int, []byte) {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			s.t.Fatalf("marshal: %v", err)
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
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := s.server.Client().Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

// call performs a request as token and decodes the JSON object it returns,
// asserting the status.
func (s *fenceStack) call(token, method, path string, body any, want int) map[string]any {
	s.t.Helper()
	status, raw := s.request(token, method, path, body)
	if status != want {
		s.t.Fatalf("%s %s = %d, want %d: %s", method, path, status, want, raw)
	}
	if len(raw) == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		s.t.Fatalf("%s %s: %v: %s", method, path, err, raw)
	}
	return out
}

// fail performs a request expected to fail and returns its status and code.
func (s *fenceStack) fail(token, method, path string, body any) (int, string) {
	s.t.Helper()
	status, raw := s.request(token, method, path, body)
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &e)
	return status, e.Code
}

// createPlace creates a place for owner and returns it.
func (s *fenceStack) createPlace(owner fencePerson, body map[string]any) map[string]any {
	s.t.Helper()
	return placeOf(s.t, s.call(owner.token, http.MethodPost, "/api/v1/places", body, http.StatusCreated))
}

func (s *fenceStack) patchPlace(owner fencePerson, id string, body map[string]any) map[string]any {
	s.t.Helper()
	return placeOf(s.t, s.call(owner.token, http.MethodPatch, "/api/v1/places/"+id, body, http.StatusOK))
}

// fenceFix is one location report from a phone.
type fenceFix struct {
	lat, lon float64
	speed    float64
	acc      float64   // metres; 5 when zero
	taken    time.Time // device clock; now when zero
}

// fix publishes a location report from p's phone with its device token, the
// way the app (or OwnTracks) does.
func (s *fenceStack) fix(p fencePerson, f fenceFix) {
	s.t.Helper()
	if f.acc == 0 {
		f.acc = 5
	}
	if f.taken.IsZero() {
		f.taken = time.Now()
	}
	s.call(p.deviceToken, http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": f.lat, "lon": f.lon, "speedMps": f.speed,
		"tst": f.taken.Unix(), "acc": f.acc,
		// A fresh sequence number: two fixes at one spot in one second are two
		// reports, not a retried duplicate.
		"seq": fenceSeq.Add(1),
	}, http.StatusOK)
}

var fenceSeq atomic.Int64

// at publishes a slow (walking-pace) fix at pt.
func (s *fenceStack) at(p fencePerson, pt domain.Point) {
	s.t.Helper()
	s.fix(p, fenceFix{lat: pt.Lat, lon: pt.Lon, speed: 0.5})
}

// ---------------------------------------------------------------- sockets

// fenceSocket is a live session whose frames are read in the background, so a
// test can both wait for one frame and assert that others never came.
type fenceSocket struct {
	t      *testing.T
	who    string
	frames chan hub.Frame
	mu     sync.Mutex
	seen   []hub.Frame
}

// socket opens p's live session and waits for its hello.
func (s *fenceStack) socket(p fencePerson) *fenceSocket {
	s.t.Helper()
	url := "ws" + strings.TrimPrefix(s.server.URL, "http") + "/ws?access_token=" + p.token
	dialCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(dialCtx, url, nil)
	if err != nil {
		s.t.Fatalf("dial as %s: %v", p.name, err)
	}
	conn.SetReadLimit(1 << 22)
	readCtx, stop := context.WithCancel(context.Background())
	ws := &fenceSocket{t: s.t, who: p.name, frames: make(chan hub.Frame, 1024)}
	go func() {
		defer close(ws.frames)
		for {
			_, data, err := conn.Read(readCtx)
			if err != nil {
				return
			}
			var f hub.Frame
			if json.Unmarshal(data, &f) == nil {
				ws.frames <- f
			}
		}
	}()
	s.t.Cleanup(func() {
		stop()
		_ = conn.CloseNow()
	})
	ws.next(hub.FrameHello, 5*time.Second, nil)
	return ws
}

// next waits for a frame of type typ that match accepts (nil accepts any),
// failing the test on timeout. Frames of other types are recorded and skipped.
func (ws *fenceSocket) next(typ string, timeout time.Duration, match func(hub.Frame) bool) hub.Frame {
	ws.t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case f, ok := <-ws.frames:
			if !ok {
				ws.t.Fatalf("%s's socket closed while waiting for %q", ws.who, typ)
			}
			ws.record(f)
			if f.Type == typ && (match == nil || match(f)) {
				return f
			}
		case <-deadline:
			ws.t.Fatalf("%s: no %q frame within %v (saw %s)", ws.who, typ, timeout, ws.summary())
			return hub.Frame{}
		}
	}
}

// drain collects what arrives within d.
func (ws *fenceSocket) drain(d time.Duration) []hub.Frame {
	var out []hub.Frame
	deadline := time.After(d)
	for {
		select {
		case f, ok := <-ws.frames:
			if !ok {
				return out
			}
			ws.record(f)
			out = append(out, f)
		case <-deadline:
			return out
		}
	}
}

// none asserts that no frame of the given types arrives within d.
func (ws *fenceSocket) none(d time.Duration, why string, types ...string) {
	ws.t.Helper()
	for _, f := range ws.drain(d) {
		for _, typ := range types {
			if f.Type == typ {
				ws.t.Fatalf("%s received a %q frame %s: %s", ws.who, f.Type, why, f.Data)
			}
		}
	}
}

func (ws *fenceSocket) record(f hub.Frame) {
	ws.mu.Lock()
	ws.seen = append(ws.seen, f)
	ws.mu.Unlock()
}

func (ws *fenceSocket) summary() string {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	parts := make([]string, 0, len(ws.seen))
	for _, f := range ws.seen {
		if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
			parts = append(parts, f.Type+":"+string(f.Data))
		} else {
			parts = append(parts, f.Type)
		}
	}
	return "[" + strings.Join(parts, ", ") + "]"
}

// geo waits for the next geo frame for placeID with the given trigger.
func (ws *fenceSocket) geo(placeID string, trigger domain.Trigger) domain.GeoEvent {
	ws.t.Helper()
	var ev domain.GeoEvent
	ws.next(hub.FrameGeo, 5*time.Second, func(f hub.Frame) bool {
		var e domain.GeoEvent
		if json.Unmarshal(f.Data, &e) != nil {
			return false
		}
		if e.PlaceID == placeID && e.Trigger == trigger {
			ev = e
			return true
		}
		return false
	})
	return ev
}

// anyGeo waits for the next geo frame, whatever it is about.
func (ws *fenceSocket) anyGeo() domain.GeoEvent {
	ws.t.Helper()
	f := ws.next(hub.FrameGeo, 5*time.Second, nil)
	var ev domain.GeoEvent
	if err := json.Unmarshal(f.Data, &ev); err != nil {
		ws.t.Fatalf("geo frame: %v", err)
	}
	return ev
}

// reminder waits for the next notify frame about placeID.
func (ws *fenceSocket) reminder(placeID string) notify.Message {
	ws.t.Helper()
	var msg notify.Message
	ws.next(hub.FrameNotify, 5*time.Second, func(f hub.Frame) bool {
		var m notify.Message
		if json.Unmarshal(f.Data, &m) != nil {
			return false
		}
		if m.PlaceID == placeID {
			msg = m
			return true
		}
		return false
	})
	return msg
}

// fenceGeoEvents decodes the geo frames among fs.
func fenceGeoEvents(fs []hub.Frame) []domain.GeoEvent {
	var out []domain.GeoEvent
	for _, f := range fs {
		if f.Type != hub.FrameGeo {
			continue
		}
		var ev domain.GeoEvent
		if json.Unmarshal(f.Data, &ev) == nil {
			out = append(out, ev)
		}
	}
	return out
}

// ---------------------------------------------------------------- geometry

// fenceOrigin is the middle of nowhere in particular, near Bengaluru.
var fenceOrigin = domain.Point{Lat: 12.9300, Lon: 77.6200}

// fenceOffset is the point distM metres from pt along bearing (degrees).
func fenceOffset(pt domain.Point, bearing, distM float64) domain.Point {
	lat, lon := geo.Destination(pt.Lat, pt.Lon, bearing, distM)
	return domain.Point{Lat: lat, Lon: lon}
}

// boxRing is an axis-aligned rectangle of half-sizes (northM, eastM) around
// c, as the wire's [{lat,lon}] ring.
func boxRing(c domain.Point, northM, eastM float64) []map[string]float64 {
	n := fenceOffset(c, 0, northM).Lat - c.Lat
	e := fenceOffset(c, 90, eastM).Lon - c.Lon
	return []map[string]float64{
		{"lat": c.Lat - n, "lon": c.Lon - e},
		{"lat": c.Lat - n, "lon": c.Lon + e},
		{"lat": c.Lat + n, "lon": c.Lon + e},
		{"lat": c.Lat + n, "lon": c.Lon - e},
	}
}

// freehandRing is what the editor sends for a dragged freehand shape: n
// vertices around c with a wobbly radius, like a finger draws.
func freehandRing(c domain.Point, radiusM float64, n int) []map[string]float64 {
	out := make([]map[string]float64, n)
	for i := 0; i < n; i++ {
		bearing := 360 * float64(i) / float64(n)
		r := radiusM * (1 + 0.08*float64((i*7)%5-2)/2)
		p := fenceOffset(c, bearing, r)
		out[i] = map[string]float64{"lat": p.Lat, "lon": p.Lon}
	}
	return out
}

func circleBody(name string, c domain.Point, radiusM int, triggers ...string) map[string]any {
	body := map[string]any{"name": name, "center": map[string]float64{"lat": c.Lat, "lon": c.Lon}, "radiusM": radiusM}
	if len(triggers) > 0 {
		body["triggers"] = triggers
	}
	return body
}

func polygonBody(name string, ring []map[string]float64, triggers ...string) map[string]any {
	body := map[string]any{"name": name, "shape": "polygon", "polygon": ring}
	if len(triggers) > 0 {
		body["triggers"] = triggers
	}
	return body
}
