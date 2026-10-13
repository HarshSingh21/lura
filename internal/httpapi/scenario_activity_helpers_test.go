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
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/activity"
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

// The activity scenarios run the whole server — HTTP, WebSocket, ingest,
// geofence engine, notify worker, share service — over a store chosen per
// test, so the same story is told against the memory store and, when
// LURA_TEST_DATABASE_URL is set, a real PostgreSQL+PostGIS. Postgres backends
// can also "restart": a second server process over the same database.

// actBackend is one store a scenario runs against.
type actBackend struct {
	name string
	// open returns a store over the backend's data. For memory every call
	// returns the same in-process store (a restart cannot keep it); for
	// Postgres each call is a fresh connection pool on the same schema, which
	// is what a server restart is.
	open func(t *testing.T) store.Store
	// durable says whether the data survives a restart.
	durable bool
}

// actBackends lists the stores to run a scenario against.
func actBackends(t *testing.T) []actBackend {
	t.Helper()
	out := []actBackend{{
		name: "memory",
		open: func() func(t *testing.T) store.Store {
			var st *memory.Store
			return func(t *testing.T) store.Store {
				if st == nil {
					st = memory.New()
				}
				return st
			}
		}(),
	}}
	if dsn := os.Getenv("LURA_TEST_DATABASE_URL"); dsn != "" {
		out = append(out, actBackend{name: "postgres", durable: true, open: actPostgres(dsn)})
	}
	return out
}

// eachActBackend runs fn once per backend as a subtest.
func eachActBackend(t *testing.T, fn func(t *testing.T, be actBackend)) {
	t.Helper()
	backends := actBackends(t)
	for _, be := range backends {
		t.Run(be.name, func(t *testing.T) { fn(t, be) })
	}
	if len(backends) == 1 {
		t.Log("LURA_TEST_DATABASE_URL unset: ran against the memory store only")
	}
}

var actSchemaSeq int

// actPostgres returns an opener for one isolated schema. The schema is
// created and migrated on the first open and dropped when the test ends.
func actPostgres(dsn string) func(t *testing.T) store.Store {
	var isolated string
	return func(t *testing.T) store.Store {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		defer cancel()
		first := isolated == ""
		if first {
			actSchemaSeq++
			schema := fmt.Sprintf("lura_act_%d_%d", time.Now().UnixNano()%1e9, actSchemaSeq)
			bootstrap, err := postgres.Open(ctx, dsn, nil)
			if err != nil {
				t.Fatalf("open bootstrap connection: %v", err)
			}
			if _, err := bootstrap.Pool().Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
				_ = bootstrap.Close()
				t.Fatalf("create schema: %v", err)
			}
			t.Cleanup(func() {
				dropCtx, dropCancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer dropCancel()
				if _, err := bootstrap.Pool().Exec(dropCtx, "DROP SCHEMA IF EXISTS "+schema+" CASCADE"); err != nil {
					t.Logf("drop schema %s: %v", schema, err)
				}
				_ = bootstrap.Close()
			})
			sep := "?"
			if strings.Contains(dsn, "?") {
				sep = "&"
			}
			isolated = dsn + sep + "search_path=" + schema + ",public"
		}
		st, err := postgres.Open(ctx, isolated, nil)
		if err != nil {
			t.Fatalf("open test connection: %v", err)
		}
		if first {
			if err := st.Migrate(ctx); err != nil {
				_ = st.Close()
				t.Fatalf("migrate: %v", err)
			}
		}
		// Registered after the schema's drop, so it runs before it.
		t.Cleanup(func() { _ = st.Close() })
		return st
	}
}

// actStack is one running server process.
type actStack struct {
	t      *testing.T
	server *httptest.Server
	store  store.Store
	auth   *multiTokenAuth
	stop   func()
}

// actOptions adjusts a stack.
type actOptions struct {
	// shareClock is the share service's clock (expiry tests).
	shareClock func() time.Time
	// coolOff overrides the per device/place/trigger cool-off (one minute).
	coolOff time.Duration
}

// newActStack boots a server process over st, wired as cmd/lura wires it.
func newActStack(t *testing.T, st store.Store, opts actOptions) *actStack {
	t.Helper()
	ctx := context.Background()

	cfg := config.Default()
	cfg.APIToken = "act-static-token-unused"
	cfg.StoreKind = st.Kind()
	cfg.AllowedOrigins = []string{"*"}
	cfg.ArriveDebounce = 2 * time.Second
	cfg.ArriveMaxSpeedMPS = 1.5
	cfg.PassbyMinSpeedMPS = 3
	cfg.CoolOff = time.Minute
	if opts.coolOff > 0 {
		cfg.CoolOff = opts.coolOff
	}
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
	if opts.shareClock != nil {
		shares.WithClock(opts.shareClock)
	}
	if err := shares.Start(ctx); err != nil {
		t.Fatalf("shares: %v", err)
	}

	hist := history.New(st, nil, history.Config{})
	tokens := &multiTokenAuth{}
	api := httpapi.New(httpapi.Deps{
		Config:   cfg,
		Store:    st,
		Bus:      b,
		Hub:      h,
		Ingest:   ingest.New(b, nil, 10000, 10000),
		Geofence: engine,
		Notify:   notifier,
		Shares:   shares,
		History:  hist,
		Activity: activity.New(st, hist),
		AI:       ai.NewRules(),
		Auth:     tokens,
		Connect:  connect.New(st, b, nil),
		Devices:  &auth.DeviceAuth{Devices: st, APIToken: cfg.APIToken, UserID: "nobody"},
		Version:  "test",
		Started:  time.Now(),
	})
	srv := httptest.NewServer(api.Handler())

	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		srv.CloseClientConnections()
		srv.Close()
		shares.Stop()
		notifier.Stop()
		engine.Stop()
		writer.Stop()
		h.Close()
		_ = b.Close()
	}
	t.Cleanup(stop)
	return &actStack{t: t, server: srv, store: st, auth: tokens, stop: stop}
}

// actPerson is an account with a session token and one phone.
type actPerson struct {
	id, email, name    string
	token              string
	deviceID, devToken string
}

// person creates (or, after a restart, re-registers) an account with a phone.
func (s *actStack) person(id, email, name string) actPerson {
	s.t.Helper()
	ctx := context.Background()
	p := actPerson{
		id: id, email: email, name: name, token: id + "-session",
		deviceID: id + "_phone", devToken: id + "-phone-token",
	}
	if _, err := s.store.GetUser(ctx, id); err != nil {
		if err := s.store.UpsertUser(ctx, domain.User{ID: id, Email: email, DisplayName: name, TZ: "UTC", Locale: "en"}); err != nil {
			s.t.Fatalf("create user %s: %v", id, err)
		}
		if err := s.store.UpsertDevice(ctx, domain.Device{
			ID: p.deviceID, UserID: id, Name: name + "'s Phone", Kind: "phone", Token: p.devToken,
		}); err != nil {
			s.t.Fatalf("create device: %v", err)
		}
	}
	s.auth.add(p.token, id)
	return p
}

// harshAndNishtha creates the reference pair.
func (s *actStack) harshAndNishtha() (actPerson, actPerson) {
	return s.person("usr_harsh", "harsh@lura.local", "Harsh"),
		s.person("usr_nishtha", "nishtha@lura.local", "Nishtha")
}

// connect makes a and b an accepted, mutually sharing connection over the API.
func (s *actStack) connect(a, b actPerson) {
	s.t.Helper()
	s.call(a, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": b.email}, http.StatusCreated)
	s.call(b, http.MethodPost, "/api/v1/people/"+a.id+"/accept", nil, http.StatusOK)
}

// raw performs a request with the given bearer token ("" for none).
func (s *actStack) raw(token, method, path string, body any) (int, []byte, http.Header) {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			s.t.Fatalf("marshal: %v", err)
		}
		reader = bytes.NewReader(buf)
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
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out, resp.Header
}

// call performs a request as p and decodes the JSON object, asserting status.
func (s *actStack) call(p actPerson, method, path string, body any, want int) map[string]any {
	s.t.Helper()
	code, raw, _ := s.raw(p.token, method, path, body)
	if code != want {
		s.t.Fatalf("%s as %s %s %s = %d, want %d: %s", p.name, method, path, "", code, want, raw)
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

// pub posts a fix from p's phone with the phone's own credential.
func (s *actStack) pub(p actPerson, lat, lon, speed float64) {
	s.t.Helper()
	code, raw, _ := s.raw(p.devToken, http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": lat, "lon": lon, "speedMps": speed,
		"tst": time.Now().Unix(), "acc": 5,
	})
	if code != http.StatusOK {
		s.t.Fatalf("pub as %s = %d: %s", p.name, code, raw)
	}
}

// ws opens p's live socket and waits for the hello.
func (s *actStack) ws(p actPerson) *websocket.Conn {
	s.t.Helper()
	return s.wsPath("/ws?access_token=" + url.QueryEscape(p.token))
}

func (s *actStack) wsPath(path string) *websocket.Conn {
	s.t.Helper()
	u := "ws" + strings.TrimPrefix(s.server.URL, "http") + path
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, u, nil)
	if err != nil {
		s.t.Fatalf("dial %s: %v", path, err)
	}
	s.t.Cleanup(func() { _ = conn.CloseNow() })
	nextFrame(s.t, conn, hub.FrameHello, 3*time.Second)
	return conn
}

// place creates a place for p and returns its id.
func (s *actStack) place(p actPerson, body map[string]any) string {
	s.t.Helper()
	res := s.call(p, http.MethodPost, "/api/v1/places", body, http.StatusCreated)
	return placeOf(s.t, res)["id"].(string)
}

// note creates a note for p and returns its id.
func (s *actStack) note(p actPerson, body map[string]any) string {
	s.t.Helper()
	body["autoSuggest"] = false
	res := s.call(p, http.MethodPost, "/api/v1/notes", body, http.StatusCreated)
	return res["note"].(map[string]any)["id"].(string)
}

// activity reads p's feed for a query string such as "?from=-2h".
func (s *actStack) activity(p actPerson, query string) []map[string]any {
	s.t.Helper()
	body := s.call(p, http.MethodGet, "/api/v1/activity"+query, nil, http.StatusOK)
	raw, ok := body["items"].([]any)
	if !ok {
		s.t.Fatalf("activity items is not an array: %v", body)
	}
	out := make([]map[string]any, 0, len(raw))
	for _, it := range raw {
		out = append(out, it.(map[string]any))
	}
	return out
}

// waitActivity polls p's feed until ok accepts it: the notify worker records
// trigger events asynchronously.
func (s *actStack) waitActivity(p actPerson, query string, ok func([]map[string]any) bool) []map[string]any {
	s.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		items := s.activity(p, query)
		if ok(items) {
			return items
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("%s's activity never settled: %s", p.name, describeItems(items))
			return nil
		}
		time.Sleep(40 * time.Millisecond)
	}
}

// ---------------------------------------------------------------- feed reading

// itemLine is a compact, human-readable form of one feed item, which keeps
// failure messages readable and order assertions simple.
func itemLine(it map[string]any) string {
	switch it["type"] {
	case "geo":
		who := it["subjectName"]
		return fmt.Sprintf("geo %v %v %v", who, it["trigger"], it["placeName"])
	case "reminder":
		r := it["reminder"].(map[string]any)
		return fmt.Sprintf("reminder %v %q %v", r["kind"], r["body"], r["status"])
	case "ack":
		return fmt.Sprintf("ack %v byMe=%v", it["ackedByName"], it["byMe"])
	case "connection":
		return fmt.Sprintf("connection %v %v byMe=%v", it["action"], it["peerName"], it["byMe"])
	case "share":
		return fmt.Sprintf("share %v %v", it["action"], it["reason"])
	case "trip", "stop":
		return fmt.Sprintf("%v %v", it["type"], it["deviceId"])
	}
	return fmt.Sprintf("%v", it["type"])
}

func describeItems(items []map[string]any) string {
	lines := make([]string, 0, len(items))
	for _, it := range items {
		lines = append(lines, it["ts"].(string)+" "+itemLine(it))
	}
	return "\n  " + strings.Join(lines, "\n  ")
}

// chronological returns the feed oldest first (it is served newest first).
func chronological(items []map[string]any) []map[string]any {
	out := make([]map[string]any, len(items))
	for i, it := range items {
		out[len(items)-1-i] = it
	}
	return out
}

// assertNewestFirst checks the feed's order.
func assertNewestFirst(t *testing.T, items []map[string]any) {
	t.Helper()
	var prev time.Time
	for i, it := range items {
		ts, err := time.Parse(time.RFC3339Nano, it["ts"].(string))
		if err != nil {
			t.Fatalf("item %d ts %v: %v", i, it["ts"], err)
		}
		if i > 0 && ts.After(prev) {
			t.Errorf("feed not newest first at %d: %s after %s%s", i, ts, prev, describeItems(items))
		}
		prev = ts
	}
}

// subsequence reports whether want appears, in order, among the lines of
// items (oldest first); other items may sit between.
func subsequence(items []map[string]any, want []string) bool {
	i := 0
	for _, it := range chronological(items) {
		if i < len(want) && strings.HasPrefix(itemLine(it), want[i]) {
			i++
		}
	}
	return i == len(want)
}

func countLines(items []map[string]any, prefix string) int {
	n := 0
	for _, it := range items {
		if strings.HasPrefix(itemLine(it), prefix) {
			n++
		}
	}
	return n
}

func itemIDs(items []map[string]any) []string {
	out := make([]string, 0, len(items))
	for _, it := range items {
		out = append(out, it["id"].(string))
	}
	return out
}
