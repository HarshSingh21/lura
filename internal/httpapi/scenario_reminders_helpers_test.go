package httpapi_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
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
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
	"github.com/HarshSingh21/locnot/internal/store/postgres"
	"github.com/coder/websocket"
	"github.com/jackc/pgx/v5"
)

// Reminder scenarios run as two real people, Harsh and Nishtha, against the
// real HTTP API and WebSocket, on the memory store and (when
// LURA_TEST_DATABASE_URL is set) on PostgreSQL. A "server restart" is a new
// server instance — new bus, hub, engine, notify worker and listener — over the
// same data, which for Postgres means a new connection pool on the same schema.

// remBackend opens a store and can reopen the same data after a restart.
type remBackend struct {
	name string
	open func(t *testing.T) (st store.Store, reopen func(t *testing.T) store.Store)
}

func remBackends(t *testing.T) []remBackend {
	t.Helper()
	backends := []remBackend{{
		name: "memory",
		open: func(t *testing.T) (store.Store, func(t *testing.T) store.Store) {
			st := memory.New()
			// The memory store lives in the process, so a restart of the
			// server keeps it — the same thing a database gives across a
			// process restart.
			return st, func(*testing.T) store.Store { return st }
		},
	}}
	dsn := os.Getenv("LURA_TEST_DATABASE_URL")
	if dsn == "" {
		return backends
	}
	return append(backends, remBackend{
		name: "postgres",
		open: func(t *testing.T) (store.Store, func(t *testing.T) store.Store) {
			return remOpenPostgres(t, dsn)
		},
	})
}

// remEachBackend runs a scenario once per backend.
func remEachBackend(t *testing.T, run func(t *testing.T, s *remStack)) {
	t.Helper()
	backends := remBackends(t)
	if len(backends) == 1 {
		t.Log("LURA_TEST_DATABASE_URL is unset: the postgres variant is skipped")
	}
	for _, b := range backends {
		t.Run(b.name, func(t *testing.T) {
			run(t, newRemStack(t, b))
		})
	}
}

// remPostGISInPublic waits until PostGIS is installed in public, installing
// it there itself when it is missing. Another package's suite may be running
// against the same database at the same time and may have just installed it
// into a schema of its own, which it drops when it finishes; until then the
// extension cannot be moved, only waited out.
func remPostGISInPublic(ctx context.Context, t *testing.T, bootstrap *postgres.Store) {
	t.Helper()
	deadline := time.Now().Add(time.Minute)
	for {
		var where string
		err := bootstrap.Pool().QueryRow(ctx, `SELECT n.nspname FROM pg_extension e
			JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'postgis'`).Scan(&where)
		switch {
		case err == nil && where == "public":
			return
		case errors.Is(err, pgx.ErrNoRows):
			// Missing: install it where it belongs. Losing a race with
			// another installer is fine; the next look decides.
			_, _ = bootstrap.Pool().Exec(ctx, "CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public")
			continue
		case err != nil:
			t.Fatalf("look up postgis: %v", err)
		}
		if time.Now().After(deadline) {
			t.Fatalf("postgis is installed in schema %q, not public", where)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

var remSchemaSeq struct {
	sync.Mutex
	n int
}

func remOpenPostgres(t *testing.T, dsn string) (store.Store, func(t *testing.T) store.Store) {
	t.Helper()
	remSchemaSeq.Lock()
	remSchemaSeq.n++
	schema := fmt.Sprintf("lura_rem_%d_%d", time.Now().UnixNano()%1e9, remSchemaSeq.n)
	remSchemaSeq.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	bootstrap, err := postgres.Open(ctx, dsn, nil)
	if err != nil {
		t.Fatalf("open bootstrap connection: %v", err)
	}
	// PostGIS must live in public. On a fresh database the first migration
	// would otherwise install it into the test schema (first on the
	// search_path), and dropping that schema would take the extension, and
	// every other test's geography columns, with it.
	remPostGISInPublic(ctx, t, bootstrap)
	if _, err := bootstrap.Pool().Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		_ = bootstrap.Close()
		t.Fatalf("create schema: %v", err)
	}
	sep := "?"
	if strings.Contains(dsn, "?") {
		sep = "&"
	}
	isolated := dsn + sep + "search_path=" + schema + ",public"

	var (
		mu    sync.Mutex
		pools []*postgres.Store
	)
	open := func(t *testing.T) store.Store {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		st, err := postgres.Open(ctx, isolated, nil)
		if err != nil {
			t.Fatalf("open postgres: %v", err)
		}
		// Migrating on every boot is what cmd/lura does (LURA_MIGRATE): the
		// second boot must find the schema current and change nothing.
		if err := st.Migrate(ctx); err != nil {
			_ = st.Close()
			t.Fatalf("migrate: %v", err)
		}
		mu.Lock()
		pools = append(pools, st)
		mu.Unlock()
		return st
	}
	t.Cleanup(func() {
		mu.Lock()
		for _, p := range pools {
			_ = p.Close()
		}
		mu.Unlock()
		dropCtx, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer dropCancel()
		if _, err := bootstrap.Pool().Exec(dropCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
			t.Logf("drop schema %s: %v", schema, err)
		}
		_ = bootstrap.Close()
	})
	return open(t), open
}

// remPushRecorder stands in for a push channel (ntfy) so a test can see what
// reached each person's phone, as opposed to their open app.
type remPushRecorder struct {
	mu   sync.Mutex
	msgs []notify.Message
}

func (r *remPushRecorder) Type() string { return "ntfy" }
func (r *remPushRecorder) Egress() bool { return false }
func (r *remPushRecorder) Send(_ context.Context, m notify.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.msgs = append(r.msgs, m)
	return nil
}

func (r *remPushRecorder) to(userID string) []notify.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []notify.Message
	for _, m := range r.msgs {
		if m.UserID == userID {
			out = append(out, m)
		}
	}
	return out
}

// remServer is one running instance of the monolith.
type remServer struct {
	http *httptest.Server
	stop func()
}

// remUser is one person: a session token, a phone with its own credential.
type remUser struct {
	id, email, name string
	token           string
	deviceID        string
	deviceToken     string
}

// remStack is the scenario harness: one data store, one server at a time.
type remStack struct {
	t       *testing.T
	backend string
	st      store.Store
	reopen  func(t *testing.T) store.Store
	auth    *multiTokenAuth
	push    *remPushRecorder
	srv     *remServer

	harsh, nishtha remUser
}

const remPlainToken = "rem-unused-api-token"

func newRemStack(t *testing.T, b remBackend) *remStack {
	t.Helper()
	st, reopen := b.open(t)
	s := &remStack{t: t, backend: b.name, st: st, reopen: reopen, auth: &multiTokenAuth{}, push: &remPushRecorder{}}
	s.harsh = s.addUser(t, "usr_harsh", "harsh@lura.local", "Harsh")
	s.nishtha = s.addUser(t, "usr_nishtha", "nishtha@lura.local", "Nishtha")
	s.boot(t)
	return s
}

// addUser creates the account and the phone directly in the store, the way a
// first Keycloak sign-in and a device enrolment would.
func (s *remStack) addUser(t *testing.T, id, email, name string) remUser {
	t.Helper()
	ctx := context.Background()
	if err := s.st.UpsertUser(ctx, domain.User{ID: id, Email: email, DisplayName: name, TZ: "UTC", Locale: "en"}); err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	if _, err := s.st.UpdateUserSettings(ctx, id, func(u *domain.User) { u.QuietFrom, u.QuietTo = "", "" }); err != nil {
		t.Fatalf("clear quiet hours for %s: %v", name, err)
	}
	u := remUser{
		id: id, email: email, name: name,
		token: id + "-session", deviceID: id + "_phone", deviceToken: id + "-device",
	}
	if err := s.st.UpsertDevice(ctx, domain.Device{
		ID: u.deviceID, UserID: id, Name: name + "'s Phone", Kind: "phone", Token: u.deviceToken,
	}); err != nil {
		t.Fatalf("create %s's phone: %v", name, err)
	}
	s.auth.add(u.token, id)
	return u
}

// secondSession signs the same person in somewhere else: another tab, the
// laptop, or the same browser after signing out and back in.
func (s *remStack) secondSession(u remUser, label string) remUser {
	u.token = u.id + "-" + label
	s.auth.add(u.token, u.id)
	return u
}

// boot starts a server instance over the current store, wired like cmd/lura.
func (s *remStack) boot(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())

	cfg := config.Default()
	cfg.APIToken = remPlainToken
	cfg.StoreKind = s.backend
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
	writer := ingest.NewWriter(s.st, b, nil, ingest.WriterOptions{BatchSize: 1, FlushEvery: 10 * time.Millisecond})
	if err := writer.Start(ctx); err != nil {
		t.Fatalf("writer: %v", err)
	}
	engine := geofence.New(s.st, b, gate.NewMemory(), nil, geofence.Config{
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
	notifier := notify.NewWorker(s.st, b, nil, notify.Config{Tries: 1},
		&notify.InApp{Bus: b}, &notify.Log{}, s.push)
	if err := notifier.Start(ctx); err != nil {
		t.Fatalf("notify: %v", err)
	}
	hist := history.New(s.st, nil, history.Config{})
	api := httpapi.New(httpapi.Deps{
		Config:   cfg,
		Store:    s.st,
		Bus:      b,
		Hub:      h,
		Ingest:   ingest.New(b, nil, cfg.IngestRatePerMin, cfg.IngestBurst),
		Geofence: engine,
		Notify:   notifier,
		History:  hist,
		AI:       ai.NewRules(),
		Auth:     s.auth,
		Connect:  connect.New(s.st, b, nil),
		Devices:  &auth.DeviceAuth{Devices: s.st, APIToken: remPlainToken, UserID: s.harsh.id},
		Version:  "test",
		Started:  time.Now(),
	})
	srv := httptest.NewServer(api.Handler())

	var once sync.Once
	stop := func() {
		once.Do(func() {
			srv.CloseClientConnections()
			srv.Close()
			notifier.Stop()
			engine.Stop()
			writer.Stop()
			h.Close()
			_ = b.Close()
			cancel()
		})
	}
	t.Cleanup(stop)
	s.srv = &remServer{http: srv, stop: stop}
}

// restart stops the running instance and boots a new one over the same data.
// For Postgres the old pool is closed first and a new one opened, so nothing
// can survive in process memory.
func (s *remStack) restart(t *testing.T) {
	t.Helper()
	s.srv.stop()
	if s.backend == "postgres" {
		if c, ok := s.st.(interface{ Close() error }); ok {
			_ = c.Close()
		}
	}
	s.st = s.reopen(t)
	s.boot(t)
}

// ---------------------------------------------------------------- HTTP

func (s *remStack) call(token, method, path string, body any) (int, []byte) {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			s.t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, s.srv.http.URL+path, reader)
	if err != nil {
		s.t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := s.srv.http.Client().Do(req)
	if err != nil {
		s.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, raw
}

// as performs a request as u and decodes the JSON object, asserting the status.
func (s *remStack) as(u remUser, method, path string, body any, want int) map[string]any {
	s.t.Helper()
	code, raw := s.call(u.token, method, path, body)
	if code != want {
		s.t.Fatalf("%s %s %s = %d, want %d: %s", u.name, method, path, code, want, raw)
	}
	if len(raw) == 0 {
		return nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		s.t.Fatalf("%s %s: not a JSON object: %v: %s", method, path, err, raw)
	}
	return out
}

// errCode performs a request expected to fail and returns its status and code.
func (s *remStack) errCode(u remUser, method, path string, body any) (int, string) {
	s.t.Helper()
	code, raw := s.call(u.token, method, path, body)
	var e struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(raw, &e)
	return code, e.Code
}

// connect makes Harsh and Nishtha accepted connections, both sharing live.
func (s *remStack) connect(t *testing.T) {
	t.Helper()
	s.as(s.harsh, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": s.nishtha.email}, http.StatusCreated)
	s.as(s.nishtha, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil, http.StatusOK)
}

// fix publishes a location from u's phone with the phone's own credential.
func (s *remStack) fix(t *testing.T, u remUser, lat, lon, speed float64) {
	t.Helper()
	s.as(remUser{name: u.name + "'s phone", token: u.deviceToken}, http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": lat, "lon": lon, "speedMps": speed,
		"tst": time.Now().Unix(), "acc": 5,
	}, http.StatusOK)
}

func (s *remStack) place(t *testing.T, u remUser, body map[string]any) string {
	t.Helper()
	return placeOf(t, s.as(u, http.MethodPost, "/api/v1/places", body, http.StatusCreated))["id"].(string)
}

func (s *remStack) note(t *testing.T, u remUser, body map[string]any) map[string]any {
	t.Helper()
	body["autoSuggest"] = false
	return s.as(u, http.MethodPost, "/api/v1/notes", body, http.StatusCreated)["note"].(map[string]any)
}

func (s *remStack) noteDone(t *testing.T, u remUser, id string) bool {
	t.Helper()
	return s.as(u, http.MethodGet, "/api/v1/notes/"+id, nil, http.StatusOK)["note"].(map[string]any)["done"] == true
}

// list reads GET /api/v1/reminders as u.
func (s *remStack) list(t *testing.T, u remUser, query string) []domain.ReminderRecord {
	t.Helper()
	code, raw := s.call(u.token, http.MethodGet, "/api/v1/reminders"+query, nil)
	if code != http.StatusOK {
		t.Fatalf("%s GET /api/v1/reminders%s = %d: %s", u.name, query, code, raw)
	}
	var body struct {
		Reminders []domain.ReminderRecord `json:"reminders"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		t.Fatalf("reminders: %v: %s", err, raw)
	}
	if body.Reminders == nil {
		t.Fatalf("reminders is not an array: %s", raw)
	}
	return body.Reminders
}

func (s *remStack) ack(t *testing.T, u remUser, id string) notify.AckResult {
	t.Helper()
	code, raw := s.call(u.token, http.MethodPost, "/api/v1/reminders/"+id+"/ack", nil)
	if code != http.StatusOK {
		t.Fatalf("%s ack %s = %d: %s", u.name, id, code, raw)
	}
	var res notify.AckResult
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatalf("ack result: %v: %s", err, raw)
	}
	return res
}

// ---------------------------------------------------------------- sockets

// remSock is a live socket read by one goroutine into a queue. Reading with
// a deadline on the websocket itself closes the connection when the deadline
// passes, so "nothing arrived for 300 ms" would kill the session; here a
// timeout only stops waiting.
type remSock struct {
	t      *testing.T
	conn   *websocket.Conn
	frames chan hub.Frame
	done   chan struct{}
}

// dial opens u's live socket and waits for hello, so nothing published after
// this returns can be missed.
func (s *remStack) dial(t *testing.T, u remUser) *remSock {
	t.Helper()
	url := "ws" + strings.TrimPrefix(s.srv.http.URL, "http") + "/ws?access_token=" + u.token
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatalf("dial as %s: %v", u.name, err)
	}
	sock := &remSock{t: t, conn: conn, frames: make(chan hub.Frame, 256), done: make(chan struct{})}
	go func() {
		defer close(sock.done)
		for {
			_, data, err := conn.Read(context.Background())
			if err != nil {
				return
			}
			var f hub.Frame
			if err := json.Unmarshal(data, &f); err == nil {
				sock.frames <- f
			}
		}
	}()
	t.Cleanup(sock.close)
	sock.next(hub.FrameHello, 3*time.Second)
	return sock
}

// close drops the socket, the way a reload or a closed tab does.
func (c *remSock) close() {
	_ = c.conn.Close(websocket.StatusGoingAway, "bye")
	_ = c.conn.CloseNow()
	<-c.done
}

// read returns the next frame, or false when none arrives within d.
func (c *remSock) read(d time.Duration) (hub.Frame, bool) {
	select {
	case f := <-c.frames:
		return f, true
	case <-time.After(d):
		return hub.Frame{}, false
	}
}

// next reads until a frame of the wanted type arrives.
func (c *remSock) next(want string, timeout time.Duration) hub.Frame {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		f, ok := c.read(time.Until(deadline))
		if !ok {
			c.t.Fatalf("timed out waiting for a %q frame", want)
		}
		if f.Type == want {
			return f
		}
	}
}

// drain collects whatever frames arrive within d.
func (c *remSock) drain(d time.Duration) []hub.Frame {
	deadline := time.Now().Add(d)
	var out []hub.Frame
	for {
		f, ok := c.read(time.Until(deadline))
		if !ok {
			return out
		}
		out = append(out, f)
	}
}

// quiet drains for d and returns what arrived, sorted by kind.
func (c *remSock) quiet(d time.Duration) remFrames {
	c.t.Helper()
	return remCollect(c.t, c.drain(d))
}

func (c *remSock) reminder() notify.Message {
	c.t.Helper()
	f := c.next(hub.FrameNotify, 5*time.Second)
	var m notify.Message
	if err := json.Unmarshal(f.Data, &m); err != nil {
		c.t.Fatalf("notify frame: %v", err)
	}
	return m
}

// reminderWithoutGeo reads up to the next notify frame and fails on a geo
// frame first: a recipient who does not own the fence never gets one.
func (c *remSock) reminderWithoutGeo() notify.Message {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, ok := c.read(time.Until(deadline))
		if !ok {
			c.t.Fatal("timed out waiting for a reminder")
		}
		switch f.Type {
		case hub.FrameGeo:
			c.t.Fatalf("a non-owner received a geo event: %s", f.Data)
		case hub.FrameNotify:
			var m notify.Message
			if err := json.Unmarshal(f.Data, &m); err != nil {
				c.t.Fatalf("notify frame: %v", err)
			}
			return m
		}
	}
}

func (c *remSock) ackFrame() notify.AckFrame {
	c.t.Helper()
	f := c.next(hub.FrameReminderAck, 5*time.Second)
	var a notify.AckFrame
	if err := json.Unmarshal(f.Data, &a); err != nil {
		c.t.Fatalf("reminder_ack frame: %v", err)
	}
	return a
}

// notifiedAt reads frames until the notify frame for a crossing of placeID
// with trigger arrives, returning every frame seen on the way, that one
// included. The notify worker handles one user's events in order, so once the
// owner's message for this crossing is here, every earlier crossing's message
// has been delivered too; waiting for the geo frame instead would race the
// worker, which publishes after the engine.
func (c *remSock) notifiedAt(placeID string, trigger domain.Trigger) []hub.Frame {
	c.t.Helper()
	deadline := time.Now().Add(8 * time.Second)
	var seen []hub.Frame
	for {
		f, ok := c.read(time.Until(deadline))
		if !ok {
			c.t.Fatalf("timed out waiting for the %s message at %s; saw %d frames", trigger, placeID, len(seen))
		}
		seen = append(seen, f)
		if f.Type != hub.FrameNotify {
			continue
		}
		var m notify.Message
		if err := json.Unmarshal(f.Data, &m); err != nil {
			c.t.Fatalf("notify frame: %v", err)
		}
		if m.PlaceID == placeID && m.Trigger == trigger {
			return seen
		}
	}
}

// remFrames sorts drained frames into what a reminder test asserts on.
type remFrames struct {
	reminders []notify.Message // notify frames
	acks      []notify.AckFrame
	geo       []domain.GeoEvent
}

func remCollect(t *testing.T, frames []hub.Frame) remFrames {
	t.Helper()
	var out remFrames
	for _, f := range frames {
		switch f.Type {
		case hub.FrameNotify:
			var m notify.Message
			if err := json.Unmarshal(f.Data, &m); err != nil {
				t.Fatalf("notify frame: %v", err)
			}
			out.reminders = append(out.reminders, m)
		case hub.FrameReminderAck:
			var a notify.AckFrame
			if err := json.Unmarshal(f.Data, &a); err != nil {
				t.Fatalf("reminder_ack frame: %v", err)
			}
			out.acks = append(out.acks, a)
		case hub.FrameGeo:
			var ev domain.GeoEvent
			if err := json.Unmarshal(f.Data, &ev); err != nil {
				t.Fatalf("geo frame: %v", err)
			}
			out.geo = append(out.geo, ev)
		}
	}
	return out
}

// stored are the notify frames that carry an acknowledgeable record.
func (f remFrames) stored() []notify.Message {
	var out []notify.Message
	for _, m := range f.reminders {
		if m.ID != "" {
			out = append(out, m)
		}
	}
	return out
}

// remEventually polls cond until it holds or the deadline passes.
func remEventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
