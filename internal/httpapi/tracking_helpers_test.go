package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
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

// The tracking scenarios run as real people against a real server: Harsh and
// Nishtha (docs/release-spec.md §5) each with their own session token and their
// own phone, plus a stranger who must never see either of them. Nothing is
// seeded: the accounts start with no connection, exactly like two people who
// have just signed up.
//
// Every scenario runs against the memory store and, when LURA_TEST_DATABASE_URL
// is set, against PostgreSQL+PostGIS in a schema of its own — the two stores
// implement the connection rules separately, and both are what ships.

// trackingUser is one account with a session and a primary phone.
type trackingUser struct {
	id, email, name string
	token           string // control-plane session
	phone           trackingDevice
}

// trackingDevice is one of a user's devices with its own ingest credential.
type trackingDevice struct {
	id, token string
}

type trackingStack struct {
	t      *testing.T
	server *httptest.Server
	store  store.Store
	bus    *bus.InProcess
	hub    *hub.Hub
	auth   *multiTokenAuth

	harsh, nishtha, stranger trackingUser
}

// forEachTrackingStore runs a scenario against every store that is available.
func forEachTrackingStore(t *testing.T, scenario func(t *testing.T, s *trackingStack)) {
	t.Helper()
	t.Run("memory", func(t *testing.T) {
		scenario(t, newTrackingStack(t, memory.New()))
	})
	t.Run("postgres", func(t *testing.T) {
		dsn := os.Getenv("LURA_TEST_DATABASE_URL")
		if dsn == "" {
			t.Skip("set LURA_TEST_DATABASE_URL to run the tracking scenarios against PostgreSQL")
		}
		scenario(t, newTrackingStack(t, trackingPostgres(t, dsn)))
	})
}

var trackingSchemaSeq atomic.Int64

// trackingPostgres opens a migrated store in a schema only this test uses.
func trackingPostgres(t *testing.T, dsn string) store.Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("lura_tracking_%d_%d", time.Now().UnixNano()%1e9, trackingSchemaSeq.Add(1))

	bootstrap, err := postgres.Open(ctx, dsn, nil)
	if err != nil {
		t.Fatalf("open bootstrap connection: %v", err)
	}
	// PostGIS must live in public. Left to the migration, it would be created
	// in the first schema on the search path — this test's — and dropped with
	// it, taking the geography type away from every other test mid-run.
	if _, err := bootstrap.Pool().Exec(ctx, "CREATE EXTENSION IF NOT EXISTS postgis SCHEMA public"); err != nil {
		var present bool
		if qerr := bootstrap.Pool().QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'postgis')`).Scan(&present); qerr != nil || !present {
			_ = bootstrap.Close()
			t.Fatalf("create postgis: %v", err)
		}
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

// newTrackingStack wires the server the way cmd/lura does, over st.
func newTrackingStack(t *testing.T, st store.Store) *trackingStack {
	t.Helper()
	ctx := context.Background()

	cfg := config.Default()
	cfg.StoreKind = "memory"
	cfg.AllowedOrigins = []string{"*"}
	cfg.ArriveDebounce = 2 * time.Second
	cfg.ArriveMaxSpeedMPS = 1.5
	cfg.PassbyMinSpeedMPS = 3
	cfg.CoolOff = time.Minute
	cfg.DwellTick = time.Hour
	cfg.EnableTraces, cfg.EnableMetrics, cfg.EnableOTLPLogs, cfg.EnablePrometheus = false, false, false, false

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
		Ingest:   ingest.New(b, nil, 6000, 600),
		Geofence: engine,
		Notify:   notifier,
		Shares:   shares,
		History:  history.New(st, nil, history.Config{}),
		AI:       ai.NewRules(),
		Auth:     tokens,
		Connect:  connect.New(st, b, nil),
		// No control-plane token may publish: every fix comes from a device.
		Devices: &auth.DeviceAuth{Devices: st},
		Version: "test",
		Started: time.Now(),
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

	s := &trackingStack{t: t, server: srv, store: st, bus: b, hub: h, auth: tokens}
	s.harsh = s.addUser(t, "usr_harsh", "harsh@lura.local", "Harsh")
	s.nishtha = s.addUser(t, "usr_nishtha", "nishtha@lura.local", "Nishtha")
	s.stranger = s.addUser(t, "usr_stranger", "stranger@lura.local", "Stranger")
	return s
}

func (s *trackingStack) addUser(t *testing.T, id, email, name string) trackingUser {
	t.Helper()
	if err := s.store.UpsertUser(context.Background(), domain.User{
		ID: id, Email: email, DisplayName: name, TZ: "UTC", Locale: "en",
	}); err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	u := trackingUser{id: id, email: email, name: name, token: id + "-session"}
	s.auth.add(u.token, id)
	u.phone = s.addDevice(t, u, "phone")
	return u
}

// addDevice gives a user another device (a laptop next to the phone).
func (s *trackingStack) addDevice(t *testing.T, u trackingUser, kind string) trackingDevice {
	t.Helper()
	d := trackingDevice{id: u.id + "_" + kind, token: u.id + "-" + kind + "-device"}
	if err := s.store.UpsertDevice(context.Background(), domain.Device{
		ID: d.id, UserID: u.id, Name: u.name + "'s " + kind, Kind: kind, Token: d.token,
	}); err != nil {
		t.Fatalf("create device %s: %v", d.id, err)
	}
	return d
}

// call performs a request as a user and returns the status and decoded body.
func (s *trackingStack) call(token, method, path string, body any) (int, map[string]any) {
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
	var out map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	return resp.StatusCode, out
}

// must performs a request and asserts its status.
func (s *trackingStack) must(u trackingUser, method, path string, body any, want int) map[string]any {
	s.t.Helper()
	got, out := s.call(u.token, method, path, body)
	if got != want {
		s.t.Fatalf("%s %s %s = %d, want %d: %v", u.name, method, path, got, want, out)
	}
	return out
}

func (s *trackingStack) invite(from, to trackingUser) map[string]any {
	s.t.Helper()
	return s.must(from, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": to.email}, http.StatusCreated)
}

func (s *trackingStack) accept(who, from trackingUser) {
	s.t.Helper()
	s.must(who, http.MethodPost, "/api/v1/people/"+from.id+"/accept", nil, http.StatusOK)
}

func (s *trackingStack) setSharing(who, with trackingUser, on bool) {
	s.t.Helper()
	s.must(who, http.MethodPatch, "/api/v1/people/"+with.id, map[string]any{"sharing": on}, http.StatusOK)
}

func (s *trackingStack) remove(who, peer trackingUser) {
	s.t.Helper()
	s.must(who, http.MethodDelete, "/api/v1/people/"+peer.id, nil, http.StatusNoContent)
}

// connect makes Harsh and Nishtha a live, two-way pair.
func (s *trackingStack) connect() {
	s.t.Helper()
	s.invite(s.harsh, s.nishtha)
	s.accept(s.nishtha, s.harsh)
}

// people returns a user's People list keyed by peer id.
func (s *trackingStack) people(u trackingUser) map[string]map[string]any {
	s.t.Helper()
	body := s.must(u, http.MethodGet, "/api/v1/people", nil, http.StatusOK)
	raw, _ := body["people"].([]any)
	out := map[string]map[string]any{}
	for _, item := range raw {
		m, _ := item.(map[string]any)
		id, _ := m["peerId"].(string)
		if _, dup := out[id]; dup {
			s.t.Fatalf("%s's People lists %s twice: %v", u.name, id, raw)
		}
		out[id] = m
	}
	return out
}

// fix is one location report from a device.
type fix struct {
	lat, lon float64
	tst      int64 // device clock, epoch seconds; 0 = untimed
	seq      int64
}

// publish posts a fix from a device with the device's own credential.
func (s *trackingStack) publish(d trackingDevice, f fix) map[string]any {
	s.t.Helper()
	payload := map[string]any{"_type": "location", "lat": f.lat, "lon": f.lon, "acc": 5, "speedMps": 1.0}
	if f.tst != 0 {
		payload["tst"] = f.tst
	}
	if f.seq != 0 {
		payload["seq"] = f.seq
	}
	got, out := s.call(d.token, http.MethodPost, "/pub", payload)
	if got != http.StatusOK {
		s.t.Fatalf("publish from %s = %d: %v", d.id, got, out)
	}
	return out
}

// at is a fix taken now at a point.
func at(lat, lon float64) fix { return fix{lat: lat, lon: lon, tst: time.Now().Unix()} }

// ---------------------------------------------------------------- sockets

// liveSocket is one open /ws connection and everything read from it.
type liveSocket struct {
	t    *testing.T
	who  string
	conn *websocket.Conn
	// frames carries every frame in arrival order; a background reader fills
	// it so a test can assert on silence without racing a blocking Read.
	frames chan hub.Frame
	// last is the newest frame time seen, which is what a client sends as
	// since= when it reconnects.
	last atomic.Pointer[time.Time]
}

// dial opens a live socket for a user and waits for hello and the snapshot.
func (s *trackingStack) dial(u trackingUser, since string) (*liveSocket, snapshotFrame) {
	s.t.Helper()
	path := "/ws?access_token=" + url.QueryEscape(u.token)
	if since != "" {
		path += "&since=" + url.QueryEscape(since)
	}
	wsURL := "ws" + strings.TrimPrefix(s.server.URL, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, nil)
	if err != nil {
		s.t.Fatalf("%s dial: %v", u.name, err)
	}
	ls := &liveSocket{t: s.t, who: u.name, conn: conn, frames: make(chan hub.Frame, 1024)}
	go ls.read()
	s.t.Cleanup(func() { _ = conn.CloseNow() })

	ls.next(hub.FrameHello)
	var snap snapshotFrame
	if err := json.Unmarshal(ls.next("snapshot").Data, &snap); err != nil {
		s.t.Fatalf("%s snapshot: %v", u.name, err)
	}
	return ls, snap
}

func (ls *liveSocket) read() {
	defer close(ls.frames)
	for {
		_, data, err := ls.conn.Read(context.Background())
		if err != nil {
			return
		}
		var f hub.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			continue
		}
		if !f.TS.IsZero() {
			if cur := ls.last.Load(); cur == nil || !f.TS.Before(*cur) {
				ts := f.TS
				ls.last.Store(&ts)
			}
		}
		ls.frames <- f
	}
}

// since is the RFC 3339 time a reconnecting client sends.
func (ls *liveSocket) since() string {
	ls.t.Helper()
	ts := ls.last.Load()
	if ts == nil {
		ls.t.Fatalf("%s has seen no frame yet", ls.who)
	}
	return ts.UTC().Format(time.RFC3339Nano)
}

func (ls *liveSocket) close() { _ = ls.conn.Close(websocket.StatusNormalClosure, "bye") }

// next returns the next frame of a type, skipping others.
func (ls *liveSocket) next(kind string) hub.Frame {
	ls.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-ls.frames:
			if !ok {
				ls.t.Fatalf("%s's socket closed waiting for %q", ls.who, kind)
			}
			if f.Type == kind {
				return f
			}
		case <-timeout:
			ls.t.Fatalf("%s: no %q frame within 5s", ls.who, kind)
		}
	}
}

// drain returns what arrives within d.
func (ls *liveSocket) drain(d time.Duration) []hub.Frame {
	var out []hub.Frame
	timeout := time.After(d)
	for {
		select {
		case f, ok := <-ls.frames:
			if !ok {
				return out
			}
			out = append(out, f)
		case <-timeout:
			return out
		}
	}
}

// positionFrom waits for a live position from a device, skipping others.
func (ls *liveSocket) positionFrom(deviceID string) domain.Position {
	ls.t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case f, ok := <-ls.frames:
			if !ok {
				ls.t.Fatalf("%s's socket closed waiting for %s", ls.who, deviceID)
			}
			if f.Type != hub.FramePosition {
				continue
			}
			pos := decodePosition(ls.t, f)
			if pos.DeviceID == deviceID {
				return pos
			}
		case <-timeout:
			ls.t.Fatalf("%s: no position from %s within 5s", ls.who, deviceID)
		}
	}
}

// positionsOf returns the positions in frames belonging to a user.
func positionsOf(t *testing.T, frames []hub.Frame, userID string) []domain.Position {
	t.Helper()
	var out []domain.Position
	for _, f := range frames {
		if f.Type != hub.FramePosition {
			continue
		}
		if pos := decodePosition(t, f); pos.UserID == userID {
			out = append(out, pos)
		}
	}
	return out
}

func decodePosition(t *testing.T, f hub.Frame) domain.Position {
	t.Helper()
	var pos domain.Position
	if err := json.Unmarshal(f.Data, &pos); err != nil {
		t.Fatalf("position frame: %v", err)
	}
	return pos
}

// snapshotFrame is the first paint a socket receives.
type snapshotFrame struct {
	Devices []struct {
		ID        string        `json:"id"`
		LastPoint *domain.Point `json:"lastPoint"`
	} `json:"devices"`
	Peers []struct {
		UserID  string               `json:"userId"`
		Devices []connect.PeerDevice `json:"devices"`
	} `json:"peers"`
}

// peer returns the snapshot's entry for a user, if any.
func (sf snapshotFrame) peer(userID string) ([]connect.PeerDevice, bool) {
	for _, p := range sf.Peers {
		if p.UserID == userID {
			return p.Devices, true
		}
	}
	return nil, false
}

// eventually polls cond until it holds or the deadline passes.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// devicePoint is the point a user's People list shows for a peer's device.
func (s *trackingStack) devicePoint(viewer trackingUser, peerID, deviceID string) *domain.Point {
	s.t.Helper()
	row, ok := s.people(viewer)[peerID]
	if !ok {
		return nil
	}
	devices, _ := row["devices"].([]any)
	for _, raw := range devices {
		d, _ := raw.(map[string]any)
		if d["id"] != deviceID {
			continue
		}
		pt, ok := d["point"].(map[string]any)
		if !ok {
			return nil
		}
		return &domain.Point{Lat: pt["lat"].(float64), Lon: pt["lon"].(float64)}
	}
	return nil
}
