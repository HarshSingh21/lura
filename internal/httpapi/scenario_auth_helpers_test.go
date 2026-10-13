package httpapi_test

// Shared helpers for the auth scenarios (scenario_auth_test.go).
//
// These tests boot the monolith the way cmd/lura does with OIDC switched on: the
// real OIDCVerifier, pointed at a fake Keycloak realm that serves discovery and a
// JWKS, and RS256 access tokens minted here with the realm's private key. Harsh
// and Nishtha are two Keycloak subjects who sign in, get provisioned on their
// first request, and use the API and the live socket exactly as two browsers
// would. Every scenario runs against the memory store and, when
// LURA_TEST_DATABASE_URL is set, against PostgreSQL in a schema of its own.

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
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

const authAudience = "lura-api"

// ---------------------------------------------------------------- fake realm

// authRealm is a fake Keycloak realm: discovery, a JWKS, and the private keys
// to sign with. It counts the requests it serves, because "how often does Lura
// call the IdP" is itself one of the things under test.
type authRealm struct {
	srv       *httptest.Server
	mu        sync.Mutex
	published map[string]*rsa.PrivateKey // kid -> key, as served in the JWKS
	jwksHits  atomic.Int64
	discHits  atomic.Int64
}

var (
	authKeyOnce sync.Once
	authKeys    [3]*rsa.PrivateKey
)

// authKey returns one of three RSA keys generated once per test binary: 2048-bit
// generation is slow enough under -race that a fresh key per test would dominate
// the suite.
func authKey(i int) *rsa.PrivateKey {
	authKeyOnce.Do(func() {
		for n := range authKeys {
			k, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				panic(err)
			}
			authKeys[n] = k
		}
	})
	return authKeys[i]
}

func newAuthRealm(t *testing.T) *authRealm {
	t.Helper()
	r := &authRealm{published: map[string]*rsa.PrivateKey{"realm-key-1": authKey(0)}}
	mux := http.NewServeMux()
	mux.HandleFunc("/realms/lura/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		r.discHits.Add(1)
		writeAuthJSON(w, map[string]any{
			"issuer":   r.issuer(),
			"jwks_uri": r.srv.URL + "/realms/lura/protocol/openid-connect/certs",
		})
	})
	mux.HandleFunc("/realms/lura/protocol/openid-connect/certs", func(w http.ResponseWriter, _ *http.Request) {
		r.jwksHits.Add(1)
		r.mu.Lock()
		keys := make([]map[string]any, 0, len(r.published))
		for kid, k := range r.published {
			keys = append(keys, map[string]any{
				"kid": kid, "kty": "RSA", "alg": "RS256", "use": "sig",
				"n": b64url(k.N.Bytes()), "e": b64url(big.NewInt(int64(k.E)).Bytes()),
			})
		}
		r.mu.Unlock()
		writeAuthJSON(w, map[string]any{"keys": keys})
	})
	r.srv = httptest.NewServer(mux)
	t.Cleanup(r.srv.Close)
	return r
}

func (r *authRealm) issuer() string { return r.srv.URL + "/realms/lura" }

// rotate replaces the published key set, as a Keycloak key rotation does.
func (r *authRealm) rotate(keys map[string]*rsa.PrivateKey) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.published = keys
}

func writeAuthJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// ---------------------------------------------------------------- identities

// authIdentity is a person as Keycloak knows them.
type authIdentity struct {
	Sub, Username, Email, Name string
}

var (
	harshID   = authIdentity{Sub: "6b1d9f3e-harsh", Username: "harsh", Email: "harsh@lura.local", Name: "Harsh"}
	nishthaID = authIdentity{Sub: "0c7a2e51-nishtha", Username: "nishtha", Email: "nishtha@lura.local", Name: "Nishtha"}
	mallory   = authIdentity{Sub: "f00dbabe-mallory", Username: "mallory", Email: "mallory@lura.local", Name: "Mallory"}
)

// tokenSpec is what a minted token says. The zero value of each field means
// "what Keycloak would put there"; tests override exactly the one thing a
// scenario is about.
type tokenSpec struct {
	who      authIdentity
	issuer   string
	audience any
	issued   time.Time
	lifetime time.Duration
	noExp    bool
	kid      string
	alg      string
	typ      string // payload typ; "" = Bearer
	headTyp  string // header typ; "" = JWT
	signWith *rsa.PrivateKey
}

// mint signs an access token for spec against the realm.
func (r *authRealm) mint(t *testing.T, spec tokenSpec) string {
	t.Helper()
	if spec.issuer == "" {
		spec.issuer = r.issuer()
	}
	if spec.audience == nil {
		spec.audience = []string{authAudience, "account"}
	}
	if spec.issued.IsZero() {
		spec.issued = time.Now()
	}
	if spec.lifetime == 0 {
		spec.lifetime = 15 * time.Minute
	}
	if spec.kid == "" {
		spec.kid = "realm-key-1"
	}
	if spec.alg == "" {
		spec.alg = "RS256"
	}
	if spec.typ == "" {
		spec.typ = "Bearer"
	}
	if spec.headTyp == "" {
		spec.headTyp = "JWT"
	}
	if spec.signWith == nil {
		spec.signWith = authKey(0)
	}
	claims := map[string]any{
		"iss":                spec.issuer,
		"aud":                spec.audience,
		"sub":                spec.who.Sub,
		"iat":                spec.issued.Unix(),
		"typ":                spec.typ,
		"azp":                "lura-app",
		"preferred_username": spec.who.Username,
		"email":              spec.who.Email,
		"email_verified":     true,
		"name":               spec.who.Name,
		"realm_access":       map[string]any{"roles": []string{"user"}},
	}
	if !spec.noExp {
		claims["exp"] = spec.issued.Add(spec.lifetime).Unix()
	}
	header := map[string]any{"alg": spec.alg, "kid": spec.kid, "typ": spec.headTyp}
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	signing := b64url(h) + "." + b64url(c)
	if spec.alg == "none" {
		return signing + "."
	}
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, spec.signWith, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signing + "." + b64url(sig)
}

// tokenFor is a valid access token for who, issued now.
func (r *authRealm) tokenFor(t *testing.T, who authIdentity) string {
	t.Helper()
	return r.mint(t, tokenSpec{who: who})
}

// ---------------------------------------------------------------- backends

// authBackend builds a fresh store for one scenario.
type authBackend struct {
	name string
	open func(t *testing.T) store.Store
}

// authBackends is memory always, plus PostgreSQL when a test database is
// configured.
func authBackends() []authBackend {
	out := []authBackend{{name: "memory", open: func(*testing.T) store.Store { return memory.New() }}}
	if dsn := os.Getenv("LURA_TEST_DATABASE_URL"); dsn != "" {
		out = append(out, authBackend{name: "postgres", open: func(t *testing.T) store.Store { return openAuthPostgres(t, dsn) }})
	}
	return out
}

var authSchemaSeq atomic.Int64

// openAuthPostgres migrates a schema of its own and drops it afterwards, so
// scenarios cannot see each other's rows.
func openAuthPostgres(t *testing.T, dsn string) store.Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	schema := fmt.Sprintf("lura_auth_%d_%d", time.Now().UnixNano()%1e9, authSchemaSeq.Add(1))

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

// eachAuthBackend runs scenario once per backend.
func eachAuthBackend(t *testing.T, scenario func(t *testing.T, b authBackend)) {
	t.Helper()
	for _, b := range authBackends() {
		t.Run(b.name, func(t *testing.T) { scenario(t, b) })
	}
}

// ---------------------------------------------------------------- the stack

// authStack is the monolith with OIDC sessions.
type authStack struct {
	t      *testing.T
	realm  *authRealm
	server *httptest.Server
	api    *httpapi.Server
	store  store.Store
	// skew moves the verifier's clock (and only its clock) forward, so a token
	// can expire under a live socket without the test sleeping 15 minutes.
	skew atomic.Int64
}

func newAuthStack(t *testing.T, b authBackend, tune func(*config.Config)) *authStack {
	t.Helper()
	ctx := context.Background()
	quiet := slog.New(slog.NewTextHandler(io.Discard, nil))

	cfg := config.Default()
	cfg.StoreKind = b.name
	cfg.AllowedOrigins = []string{"*"}
	cfg.ArriveDebounce = 2 * time.Second
	cfg.ArriveMaxSpeedMPS = 1.5
	cfg.PassbyMinSpeedMPS = 3
	cfg.CoolOff = time.Minute
	cfg.DwellTick = time.Hour
	cfg.EnableTraces, cfg.EnableMetrics, cfg.EnableOTLPLogs, cfg.EnablePrometheus = false, false, false, false
	if tune != nil {
		tune(&cfg)
	}

	s := &authStack{t: t, realm: newAuthRealm(t)}
	st := b.open(t)
	s.store = st

	verifier, err := auth.NewOIDC(ctx, auth.OIDCConfig{
		Issuer:   s.realm.issuer(),
		Audience: authAudience,
		Clock:    func() time.Time { return time.Now().Add(time.Duration(s.skew.Load())) },
	})
	if err != nil {
		t.Fatalf("oidc verifier: %v", err)
	}

	bs := bus.NewInProcess(quiet)
	h, err := hub.New(bs, quiet)
	if err != nil {
		t.Fatalf("hub: %v", err)
	}
	writer := ingest.NewWriter(st, bs, quiet, ingest.WriterOptions{BatchSize: 1, FlushEvery: 10 * time.Millisecond})
	if err := writer.Start(ctx); err != nil {
		t.Fatalf("writer: %v", err)
	}
	engine := geofence.New(st, bs, gate.NewMemory(), quiet, geofence.Config{
		FreshWindow: cfg.FreshWindow, ArriveDebounce: cfg.ArriveDebounce,
		ArriveMaxSpeedMPS: cfg.ArriveMaxSpeedMPS, PassbyMinSpeedMPS: cfg.PassbyMinSpeedMPS,
		CoolOff: cfg.CoolOff, DwellTick: cfg.DwellTick, Partitions: 1,
	})
	if err := engine.Start(ctx); err != nil {
		t.Fatalf("geofence: %v", err)
	}
	notifier := notify.NewWorker(st, bs, quiet, notify.Config{Tries: 1}, &notify.InApp{Bus: bs}, &notify.Log{})
	if err := notifier.Start(ctx); err != nil {
		t.Fatalf("notify: %v", err)
	}
	shares := share.New(st, bs, quiet, "")
	if err := shares.Start(ctx); err != nil {
		t.Fatalf("shares: %v", err)
	}

	s.api = httpapi.New(httpapi.Deps{
		Config:   cfg,
		Store:    st,
		Bus:      bs,
		Hub:      h,
		Ingest:   ingest.New(bs, quiet, cfg.IngestRatePerMin, cfg.IngestBurst),
		Geofence: engine,
		Notify:   notifier,
		Shares:   shares,
		History:  history.New(st, quiet, history.Config{}),
		AI:       ai.NewRules(),
		Auth:     verifier,
		Connect:  connect.New(st, bs, quiet),
		// Production wiring with OIDC: devices publish with their own token only.
		Devices: &auth.DeviceAuth{Devices: st},
		Log:     quiet,
		Version: "test",
	})
	s.server = httptest.NewServer(s.api.Handler())
	t.Cleanup(func() {
		s.server.Close()
		shares.Stop()
		notifier.Stop()
		engine.Stop()
		writer.Stop()
		h.Close()
		_ = bs.Close()
	})
	return s
}

// advanceVerifierClock moves the verifier's notion of now forward by d.
func (s *authStack) advanceVerifierClock(d time.Duration) { s.skew.Add(int64(d)) }

// ---------------------------------------------------------------- HTTP

// authResp is a response read in full.
type authResp struct {
	status int
	header http.Header
	body   []byte
}

func (r authResp) object(t *testing.T) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(r.body, &out); err != nil {
		t.Fatalf("body is not a JSON object: %v: %s", err, r.body)
	}
	return out
}

// call sends a request with an optional bearer token.
func (s *authStack) call(token, method, path string, body any) authResp {
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
	return authResp{status: resp.StatusCode, header: resp.Header, body: raw}
}

// must sends a request and asserts its status, returning the decoded object.
func (s *authStack) must(token, method, path string, body any, want int) map[string]any {
	s.t.Helper()
	r := s.call(token, method, path, body)
	if r.status != want {
		s.t.Fatalf("%s %s = %d, want %d: %s", method, path, r.status, want, r.body)
	}
	if len(bytes.TrimSpace(r.body)) == 0 {
		return nil
	}
	return r.object(s.t)
}

// ---------------------------------------------------------------- people

// authUser is a signed-in person with a phone.
type authUser struct {
	id          authIdentity
	token       string
	deviceID    string
	deviceToken string
}

// signIn makes the person's first request (which provisions them) and registers
// their phone, the way the app does on first launch.
func (s *authStack) signIn(who authIdentity) *authUser {
	s.t.Helper()
	u := &authUser{id: who, token: s.realm.tokenFor(s.t, who)}
	me := s.must(u.token, http.MethodGet, "/api/v1/me", nil, http.StatusOK)
	if got := asMap(s.t, me["user"])["id"]; got != who.Sub {
		s.t.Fatalf("/me for %s = %v", who.Name, me)
	}
	dev := s.must(u.token, http.MethodPost, "/api/v1/devices", map[string]any{"name": who.Name + "'s Phone"}, http.StatusCreated)
	u.deviceID = asMap(s.t, dev["device"])["id"].(string)
	u.deviceToken = dev["pubToken"].(string)
	return u
}

// connect has a invite b and b accept: a mutual, live connection.
func (s *authStack) connect(a, b *authUser) {
	s.t.Helper()
	s.must(a.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": b.id.Email}, http.StatusCreated)
	s.must(b.token, http.MethodPost, "/api/v1/people/"+a.id.Sub+"/accept", nil, http.StatusOK)
}

// pub publishes a fix from the user's phone with the phone's own credential.
func (s *authStack) pub(u *authUser, lat, lon, speed float64) {
	s.t.Helper()
	s.must(u.deviceToken, http.MethodPost, "/pub", map[string]any{
		"_type": "location", "lat": lat, "lon": lon, "speedMps": speed,
		"tst": time.Now().Unix(), "acc": 5,
	}, http.StatusOK)
}

func asMap(t *testing.T, v any) map[string]any {
	t.Helper()
	m, ok := v.(map[string]any)
	if !ok {
		t.Fatalf("not an object: %#v", v)
	}
	return m
}

// ---------------------------------------------------------------- live socket

func (s *authStack) wsURL(path string) string {
	return "ws" + strings.TrimPrefix(s.server.URL, "http") + path
}

// dialAs opens the live socket with the token in the query string, as a
// browser must. It fails the test when the handshake is refused.
func (s *authStack) dialAs(token, extraQuery string) *websocket.Conn {
	s.t.Helper()
	conn, status, err := s.tryDial(token, extraQuery, nil)
	if err != nil {
		s.t.Fatalf("dial /ws: status %d: %v", status, err)
	}
	return conn
}

// tryDial attempts the handshake and reports the HTTP status it got.
func (s *authStack) tryDial(token, extraQuery string, header http.Header) (*websocket.Conn, int, error) {
	s.t.Helper()
	q := url.Values{}
	if token != "" {
		q.Set("access_token", token)
	}
	path := "/ws"
	if enc := q.Encode(); enc != "" || extraQuery != "" {
		path += "?" + enc
		if extraQuery != "" {
			if enc != "" {
				path += "&"
			}
			path += extraQuery
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, s.wsURL(path), &websocket.DialOptions{HTTPHeader: header})
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	if err != nil {
		return nil, status, err
	}
	s.t.Cleanup(func() { _ = conn.CloseNow() })
	return conn, status, nil
}

// authFrames reads frames for up to d and returns them all.
func authFrames(t *testing.T, conn *websocket.Conn, d time.Duration) []hub.Frame {
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

// awaitFrame reads until match accepts a frame, failing after timeout. Frames
// read on the way are returned too, so a test can assert what must NOT have
// arrived among them.
func awaitFrame(t *testing.T, conn *websocket.Conn, timeout time.Duration, what string, match func(hub.Frame) bool) (hub.Frame, []hub.Frame) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var seen []hub.Frame
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("waiting for %s: %v (saw %s)", what, err, frameTypes(seen))
		}
		var f hub.Frame
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("undecodable frame: %v", err)
		}
		seen = append(seen, f)
		if match(f) {
			return f, seen
		}
	}
}

func frameTypes(frames []hub.Frame) string {
	parts := make([]string, 0, len(frames))
	for _, f := range frames {
		parts = append(parts, f.Type)
	}
	return "[" + strings.Join(parts, " ") + "]"
}

// positionOf reports whose device a position frame is for.
func positionOf(t *testing.T, f hub.Frame) (userID, deviceID string) {
	t.Helper()
	var p struct {
		UserID   string `json:"userId"`
		DeviceID string `json:"deviceId"`
	}
	if err := json.Unmarshal(f.Data, &p); err != nil {
		t.Fatalf("position frame: %v", err)
	}
	return p.UserID, p.DeviceID
}
