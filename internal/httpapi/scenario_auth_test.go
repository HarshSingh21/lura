package httpapi_test

// Auth and session scenarios, driven over real HTTP and WebSockets by two
// Keycloak users, Harsh and Nishtha, against a server running the production
// OIDC verifier. Helpers are in scenario_auth_helpers_test.go.

import (
	"context"
	"crypto/rsa"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/httpapi"
	"github.com/go-chi/chi/v5"
)

// badCredential is one way a request can fail to be a valid session.
type badCredential struct {
	name  string
	token func(s *authStack, t *testing.T) string
}

// badCredentials covers every rejection docs/auth.md §3 lists, plus the
// shapes a client actually sends by mistake.
func badCredentials() []badCredential {
	mint := func(spec tokenSpec) func(s *authStack, t *testing.T) string {
		return func(s *authStack, t *testing.T) string {
			if spec.who.Sub == "" {
				spec.who = harshID
			}
			return s.realm.mint(t, spec)
		}
	}
	fixed := func(v string) func(*authStack, *testing.T) string {
		return func(*authStack, *testing.T) string { return v }
	}
	return []badCredential{
		{"no token", fixed("")},
		{"garbage", fixed("not-a-jwt")},
		{"the static development token", fixed("lura-dev-token")},
		{"expired", mint(tokenSpec{issued: time.Now().Add(-30 * time.Minute)})},
		{"no exp", mint(tokenSpec{noExp: true})},
		{"issued in the future", mint(tokenSpec{issued: time.Now().Add(10 * time.Minute)})},
		{"another realm's issuer", func(s *authStack, t *testing.T) string {
			return s.realm.mint(t, tokenSpec{who: harshID, issuer: s.realm.srv.URL + "/realms/other"})
		}},
		{"issuer prefix", func(s *authStack, t *testing.T) string {
			return s.realm.mint(t, tokenSpec{who: harshID, issuer: s.realm.issuer() + "-evil"})
		}},
		{"audience is not lura-api", mint(tokenSpec{audience: []string{"account", "lura-app"}})},
		{"signed by a key the realm does not publish", mint(tokenSpec{signWith: authKey(1)})},
		{"unknown kid", mint(tokenSpec{kid: "forged-kid", signWith: authKey(1)})},
		{"alg none", mint(tokenSpec{alg: "none"})},
		{"refresh token (payload typ)", mint(tokenSpec{typ: "Refresh"})},
		{"refresh token (header typ)", mint(tokenSpec{headTyp: "Refresh"})},
		{"ID token", mint(tokenSpec{typ: "ID"})},
		{"no subject", func(s *authStack, t *testing.T) string {
			return s.realm.mint(t, tokenSpec{who: authIdentity{Email: "ghost@lura.local", Name: "Ghost"}})
		}},
		{"tampered payload", func(s *authStack, t *testing.T) string {
			good := strings.Split(s.realm.tokenFor(t, harshID), ".")
			other := strings.Split(s.realm.tokenFor(t, nishthaID), ".")
			return good[0] + "." + other[1] + "." + good[2]
		}},
	}
}

// controlPlaneRoutes walks the router for every /api/v1 route, so a route added
// later is covered without anyone remembering to list it.
func controlPlaneRoutes(t *testing.T, api *httpapi.Server) [][2]string {
	t.Helper()
	var out [][2]string
	err := chi.Walk(httpapi.RoutesForTest(api), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if !strings.HasPrefix(route, "/api/v1") {
			return nil
		}
		path := route
		for _, p := range []string{"{id}", "{peerId}"} {
			path = strings.ReplaceAll(path, p, "x_1")
		}
		out = append(out, [2]string{method, path})
		return nil
	})
	if err != nil {
		t.Fatalf("walk routes: %v", err)
	}
	if len(out) < 30 {
		t.Fatalf("only %d control-plane routes found: %v", len(out), out)
	}
	return out
}

// Scenario: every protected route answers 401 with a Bearer challenge to every
// kind of bad credential, and the answer does not tell the caller why.
func TestAuthScenarioEveryProtectedRouteRefusesABadSession(t *testing.T) {
	s := newAuthStack(t, authBackends()[0], nil)
	routes := controlPlaneRoutes(t, s.api)

	for _, cred := range badCredentials() {
		t.Run(cred.name, func(t *testing.T) {
			token := cred.token(s, t)
			for _, rt := range routes {
				var body any
				if rt[0] != http.MethodGet && rt[0] != http.MethodDelete {
					body = map[string]any{}
				}
				r := s.call(token, rt[0], rt[1], body)
				if r.status != http.StatusUnauthorized {
					t.Errorf("%s %s = %d, want 401: %s", rt[0], rt[1], r.status, r.body)
					continue
				}
				if !strings.HasPrefix(r.header.Get("WWW-Authenticate"), "Bearer") {
					t.Errorf("%s %s: WWW-Authenticate = %q", rt[0], rt[1], r.header.Get("WWW-Authenticate"))
				}
				// The detail is for the log, not the client (internal/auth/oidc.go):
				// a 401 that names the expected issuer or audience is a recipe.
				for _, leak := range []string{s.realm.issuer(), authAudience, "want", "kid", "oidc"} {
					if strings.Contains(string(r.body), leak) {
						t.Errorf("%s %s: 401 body leaks %q: %s", rt[0], rt[1], leak, r.body)
						break
					}
				}
			}

			// The live socket is refused at the handshake, the same way.
			if _, status, err := s.tryDial(token, "", nil); err == nil || status != http.StatusUnauthorized {
				t.Errorf("/ws handshake = %d (err %v), want 401", status, err)
			}
		})
	}

	// Nobody was provisioned by a rejected token.
	for _, who := range []authIdentity{harshID, nishthaID} {
		if _, err := s.store.GetUser(context.Background(), who.Sub); err == nil {
			t.Errorf("%s was provisioned by a rejected request", who.Name)
		}
	}

	// And the same routes do let a valid session through.
	good := s.realm.tokenFor(t, harshID)
	for _, rt := range routes {
		var body any
		if rt[0] != http.MethodGet && rt[0] != http.MethodDelete {
			body = map[string]any{}
		}
		if r := s.call(good, rt[0], rt[1], body); r.status == http.StatusUnauthorized {
			t.Errorf("%s %s with a valid token = 401: %s", rt[0], rt[1], r.body)
		}
	}
}

// Scenario: a token transported every way a client sends one is accepted —
// header for fetch, ?access_token= for the browser's socket — and a person's
// session is never a device credential for /pub.
func TestAuthScenarioTokenTransportsAndPubSeparation(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh := s.signIn(harshID)

		if r := s.call(harsh.token, http.MethodGet, "/api/v1/overview", nil); r.status != http.StatusOK {
			t.Errorf("Authorization header = %d", r.status)
		}
		if r := s.call("", http.MethodGet, "/api/v1/overview?access_token="+harsh.token, nil); r.status != http.StatusOK {
			t.Errorf("?access_token = %d", r.status)
		}
		if _, status, err := s.tryDial("", "", http.Header{"Authorization": {"Bearer " + harsh.token}}); err != nil {
			t.Errorf("/ws with the header = %d: %v", status, err)
		}
		s.dialAs(harsh.token, "")

		// A session token is not a device token, and a device token is not a session.
		r := s.call(harsh.token, http.MethodPost, "/pub", map[string]any{"_type": "location", "lat": 12.9, "lon": 77.6, "tst": time.Now().Unix()})
		if r.status != http.StatusUnauthorized {
			t.Errorf("/pub with a session token = %d, want 401", r.status)
		}
		if r := s.call(harsh.deviceToken, http.MethodGet, "/api/v1/overview", nil); r.status != http.StatusUnauthorized {
			t.Errorf("control plane with a device token = %d, want 401", r.status)
		}
		if _, status, err := s.tryDial(harsh.deviceToken, "", nil); err == nil || status != http.StatusUnauthorized {
			t.Errorf("/ws with a device token = %d, want 401", status)
		}
	})
}

// Scenario: the first sign-in creates the account from the token's claims, and
// the app's burst of first requests (REST and the socket together) all succeed.
func TestAuthScenarioFirstSignInProvisionsTheAccountOnce(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		token := s.realm.tokenFor(t, nishthaID)

		var wg sync.WaitGroup
		statuses := make([]int, 12)
		for i := range statuses {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				path := []string{"/api/v1/me", "/api/v1/overview", "/api/v1/reminders?status=pending", "/api/v1/people"}[i%4]
				statuses[i] = s.call(token, http.MethodGet, path, nil).status
			}(i)
		}
		wg.Add(1)
		var wsStatus int
		var wsErr error
		go func() {
			defer wg.Done()
			_, wsStatus, wsErr = s.tryDial(token, "", nil)
		}()
		wg.Wait()
		for i, st := range statuses {
			if st != http.StatusOK {
				t.Errorf("first-burst request %d = %d", i, st)
			}
		}
		if wsErr != nil {
			t.Errorf("first socket = %d: %v", wsStatus, wsErr)
		}

		me := asMap(t, s.must(token, http.MethodGet, "/api/v1/me", nil, http.StatusOK)["user"])
		if me["id"] != nishthaID.Sub || me["email"] != nishthaID.Email || me["displayName"] != "Nishtha" {
			t.Errorf("provisioned account = %v", me)
		}

		// Signing in again — a new token for the same subject — is the same account.
		again := s.realm.mint(t, tokenSpec{who: nishthaID, issued: time.Now().Add(time.Second)})
		if me2 := asMap(t, s.must(again, http.MethodGet, "/api/v1/me", nil, http.StatusOK)["user"]); me2["id"] != nishthaID.Sub {
			t.Errorf("second sign-in = %v", me2)
		}
	})
}

// Scenario: a flood of tokens naming made-up key ids is refused without turning
// Lura into a load generator aimed at Keycloak; a real key rotation is picked
// up once the cooldown has passed, and a retired key stops verifying.
func TestAuthScenarioForgedKidFloodAndKeyRotation(t *testing.T) {
	s := newAuthStack(t, authBackends()[0], nil)
	harsh := s.signIn(harshID)
	baseJWKS := s.realm.jwksHits.Load()

	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			forged := s.realm.mint(t, tokenSpec{who: harshID, kid: "forged-" + string(rune('a'+i%26)), signWith: authKey(1)})
			if r := s.call(forged, http.MethodGet, "/api/v1/me", nil); r.status != http.StatusUnauthorized {
				t.Errorf("forged kid = %d", r.status)
			}
		}(i)
	}
	wg.Wait()
	if extra := s.realm.jwksHits.Load() - baseJWKS; extra > 1 {
		t.Errorf("40 forged kids caused %d JWKS fetches, want at most 1", extra)
	}
	// Valid sessions kept working throughout.
	s.must(harsh.token, http.MethodGet, "/api/v1/me", nil, http.StatusOK)

	// Keycloak rotates: realm-key-2 is now the active key, realm-key-1 retired.
	s.realm.rotate(map[string]*rsa.PrivateKey{"realm-key-2": authKey(2)})
	rotated := s.realm.mint(t, tokenSpec{who: harshID, kid: "realm-key-2", signWith: authKey(2)})
	// Inside the cooldown the new kid cannot be fetched yet...
	if r := s.call(rotated, http.MethodGet, "/api/v1/me", nil); r.status != http.StatusUnauthorized {
		t.Logf("rotated key accepted inside the cooldown (refresh budget was unused): %d", r.status)
	}
	// ...after it, it is.
	s.advanceVerifierClock(31 * time.Second)
	s.must(rotated, http.MethodGet, "/api/v1/me", nil, http.StatusOK)
	// The refresh replaced the key set wholesale: the retired key no longer verifies.
	stale := s.realm.mint(t, tokenSpec{who: harshID, issued: time.Now().Add(31 * time.Second)})
	if r := s.call(stale, http.MethodGet, "/api/v1/me", nil); r.status != http.StatusUnauthorized {
		t.Errorf("token signed by the retired key = %d, want 401", r.status)
	}
}
