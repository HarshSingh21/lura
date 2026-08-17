package auth_test

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/domain"
)

// The IdP is stubbed rather than mocked: a real discovery document, a real
// JWKS and real signatures, so the code under test does the same work it does
// against Keycloak.

const (
	testAudience = "lura-api"
	testKID      = "sig-1"
	testSubject  = "3f2b9a10-6c4e-4e2a-9d1b-5f0e7c2a8b31"
)

// Key generation is the slow part of these tests, so each key is made once.
var (
	signingKey = sync.OnceValue(func() *rsa.PrivateKey { return genRSA() })
	foreignKey = sync.OnceValue(func() *rsa.PrivateKey { return genRSA() })
	ecKey      = sync.OnceValue(func() *ecdsa.PrivateKey {
		k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			panic(err)
		}
		return k
	})
)

func genRSA() *rsa.PrivateKey {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		panic(err)
	}
	return k
}

// idp stands in for Keycloak. It counts requests so the tests can assert how
// often the verifier calls out, and can be taken "down" to model a slow boot.
type idp struct {
	srv *httptest.Server

	mu            sync.Mutex
	up            bool
	keys          []map[string]any
	jwksHits      int
	discoveryHits int
}

func newIDP(t *testing.T, keys ...map[string]any) *idp {
	t.Helper()
	i := &idp{up: true, keys: keys}

	mux := http.NewServeMux()
	mux.HandleFunc("/realms/lura/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		i.mu.Lock()
		i.discoveryHits++
		up := i.up
		i.mu.Unlock()
		if !up {
			http.Error(w, "realm not ready", http.StatusServiceUnavailable)
			return
		}
		// Built from r.Host so the document always matches the URL it was
		// fetched from, exactly as a real issuer's does.
		base := "http://" + r.Host + "/realms/lura"
		writeJSON(w, map[string]any{
			"issuer":   base,
			"jwks_uri": base + "/protocol/openid-connect/certs",
		})
	})
	// A realm whose discovery document names someone else's issuer: the
	// misconfiguration (or redirect) the verifier must refuse rather than
	// silently verify against another realm's keys.
	mux.HandleFunc("/realms/imposter/.well-known/openid-configuration", func(w http.ResponseWriter, r *http.Request) {
		i.mu.Lock()
		i.discoveryHits++
		i.mu.Unlock()
		base := "http://" + r.Host + "/realms/lura"
		writeJSON(w, map[string]any{
			"issuer":   base,
			"jwks_uri": base + "/protocol/openid-connect/certs",
		})
	})
	mux.HandleFunc("/realms/lura/protocol/openid-connect/certs", func(w http.ResponseWriter, r *http.Request) {
		i.mu.Lock()
		i.jwksHits++
		up, keys := i.up, append([]map[string]any(nil), i.keys...)
		i.mu.Unlock()
		if !up {
			http.Error(w, "realm not ready", http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, map[string]any{"keys": keys})
	})

	i.srv = httptest.NewServer(mux)
	t.Cleanup(i.srv.Close)
	return i
}

func (i *idp) issuer() string { return i.srv.URL + "/realms/lura" }

func (i *idp) setUp(up bool) {
	i.mu.Lock()
	i.up = up
	i.mu.Unlock()
}

func (i *idp) setKeys(keys ...map[string]any) {
	i.mu.Lock()
	i.keys = keys
	i.mu.Unlock()
}

func (i *idp) hits() (jwks, discovery int) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.jwksHits, i.discoveryHits
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// fakeClock is the injected clock; guarded because the verifier reads it from
// whichever goroutine is verifying.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)}
}

func rsaJWK(kid string, pub *rsa.PublicKey, alg, use string) map[string]any {
	return map[string]any{
		"kty": "RSA",
		"kid": kid,
		"alg": alg,
		"use": use,
		"n":   b64(pub.N.Bytes()),
		"e":   b64(big.NewInt(int64(pub.E)).Bytes()),
	}
}

func ecJWK(kid string, pub *ecdsa.PublicKey) map[string]any {
	return map[string]any{
		"kty": "EC",
		"kid": kid,
		"alg": "ES256",
		"use": "sig",
		"crv": "P-256",
		"x":   b64(pub.X.FillBytes(make([]byte, 32))),
		"y":   b64(pub.Y.FillBytes(make([]byte, 32))),
	}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func segment(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal segment: %v", err)
	}
	return b64(raw)
}

// claimSet is a plausible Keycloak access token payload.
func claimSet(issuer string, now time.Time) map[string]any {
	return map[string]any{
		"iss":                issuer,
		"sub":                testSubject,
		"aud":                []string{testAudience, "account"},
		"exp":                now.Add(time.Hour).Unix(),
		"iat":                now.Unix(),
		"nbf":                now.Add(-time.Minute).Unix(),
		"typ":                "Bearer",
		"azp":                "lura-web",
		"preferred_username": "harsh",
		"email":              "harsh@example.com",
		"email_verified":     true,
		"name":               "Harsh Singh",
		"realm_access":       map[string]any{"roles": []string{"lura-user", "offline_access"}},
	}
}

// signRSA mints a token with the given header and claims. The header is
// explicit because half these tests are about what happens when it lies.
func signRSA(t *testing.T, key *rsa.PrivateKey, header, claims map[string]any) string {
	t.Helper()
	signing := segment(t, header) + "." + segment(t, claims)

	var digest []byte
	var id crypto.Hash
	switch header["alg"] {
	case "RS384":
		sum := sha512.Sum384([]byte(signing))
		digest, id = sum[:], crypto.SHA384
	case "RS512":
		sum := sha512.Sum512([]byte(signing))
		digest, id = sum[:], crypto.SHA512
	default:
		sum := sha256.Sum256([]byte(signing))
		digest, id = sum[:], crypto.SHA256
	}
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, id, digest)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	return signing + "." + b64(sig)
}

func signES256(t *testing.T, key *ecdsa.PrivateKey, kid string, claims map[string]any) string {
	t.Helper()
	signing := segment(t, map[string]any{"alg": "ES256", "typ": "JWT", "kid": kid}) + "." + segment(t, claims)
	sum := sha256.Sum256([]byte(signing))
	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// JWS wants the fixed-width r||s pair, not DER.
	sig := append(r.FillBytes(make([]byte, 32)), s.FillBytes(make([]byte, 32))...)
	return signing + "." + b64(sig)
}

func rsaHeader() map[string]any {
	return map[string]any{"alg": "RS256", "typ": "JWT", "kid": testKID}
}

func newVerifier(t *testing.T, i *idp, clock *fakeClock) *auth.OIDCVerifier {
	t.Helper()
	v, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		Issuer:     i.issuer(),
		Audience:   testAudience,
		HTTPClient: i.srv.Client(),
		Clock:      clock.Now,
	})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}
	return v
}

// defaultIDP publishes the signing key plus the encryption key Keycloak
// advertises alongside it.
func defaultIDP(t *testing.T) *idp {
	t.Helper()
	return newIDP(t,
		rsaJWK(testKID, &signingKey().PublicKey, "RS256", "sig"),
		rsaJWK("enc-1", &foreignKey().PublicKey, "RSA-OAEP", "enc"),
	)
}

func TestVerifyTokenAcceptsAValidTokenAndMapsClaims(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	tok := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))
	claims, err := v.VerifyToken(context.Background(), tok)
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}

	if claims.Subject != testSubject {
		t.Errorf("Subject = %q, want %q", claims.Subject, testSubject)
	}
	if claims.Username != "harsh" {
		t.Errorf("Username = %q, want %q", claims.Username, "harsh")
	}
	if claims.Email != "harsh@example.com" {
		t.Errorf("Email = %q", claims.Email)
	}
	if claims.Name != "Harsh Singh" {
		t.Errorf("Name = %q", claims.Name)
	}
	if !claims.EmailVerified {
		t.Error("EmailVerified = false, want true")
	}
	if !claims.HasRole("lura-user") {
		t.Errorf("Roles = %v, want it to contain lura-user", claims.Roles)
	}
	if claims.Issuer != i.issuer() {
		t.Errorf("Issuer = %q, want %q", claims.Issuer, i.issuer())
	}
	if want := clock.Now().Add(time.Hour); !claims.ExpiresAt.Equal(want) {
		t.Errorf("ExpiresAt = %s, want %s", claims.ExpiresAt, want)
	}
}

func TestAuthenticateBuildsAUserPrincipal(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	tok := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))
	r := httptest.NewRequest(http.MethodGet, "/api/places", nil)
	r.Header.Set("Authorization", "Bearer "+tok)

	p, err := v.Authenticate(r)
	if err != nil {
		t.Fatalf("Authenticate: %v", err)
	}
	if !p.IsUser() {
		t.Fatalf("principal = %+v, want a user principal", p)
	}
	if p.Kind != auth.KindUser || p.UserID != testSubject {
		t.Errorf("principal = %+v, want kind=user userID=%s", p, testSubject)
	}
	if p.DeviceID != "" || p.ShareToken != "" {
		t.Errorf("principal leaked device/share fields: %+v", p)
	}
}

// A WebSocket cannot set headers, and some clients only know X-Lura-Token, so
// every transport BearerToken supports must reach the verifier.
func TestAuthenticateAcceptsEveryTokenTransport(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)
	tok := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))

	tests := []struct {
		name    string
		request func() *http.Request
	}{
		{"authorization header", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/places", nil)
			r.Header.Set("Authorization", "Bearer "+tok)
			return r
		}},
		{"lowercase bearer scheme", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/places", nil)
			r.Header.Set("Authorization", "bearer "+tok)
			return r
		}},
		{"access_token query param", func() *http.Request {
			return httptest.NewRequest(http.MethodGet, "/ws?access_token="+tok, nil)
		}},
		{"x-lura-token header", func() *http.Request {
			r := httptest.NewRequest(http.MethodGet, "/api/places", nil)
			r.Header.Set("X-Lura-Token", tok)
			return r
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p, err := v.Authenticate(tc.request())
			if err != nil {
				t.Fatalf("Authenticate: %v", err)
			}
			if p.UserID != testSubject {
				t.Errorf("UserID = %q, want %q", p.UserID, testSubject)
			}
		})
	}

	t.Run("no credentials", func(t *testing.T) {
		_, err := v.Authenticate(httptest.NewRequest(http.MethodGet, "/api/places", nil))
		if !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatalf("err = %v, want ErrUnauthorized", err)
		}
	})
}

func TestVerifyTokenRejectsBadClaims(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	// Warm the key cache once so every case exercises claim validation rather
	// than the JWKS fetch rate limit.
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); err != nil {
		t.Fatalf("warm-up token rejected: %v", err)
	}

	tests := []struct {
		name   string
		mutate func(c map[string]any)
		want   string
	}{
		{"wrong issuer", func(c map[string]any) { c["iss"] = "https://evil.example/realms/lura" }, "issuer"},
		{"issuer of another realm on the same host", func(c map[string]any) {
			c["iss"] = strings.TrimSuffix(i.issuer(), "lura") + "other"
		}, "issuer"},
		{"audience missing ours", func(c map[string]any) { c["aud"] = []string{"account", "admin-cli"} }, "audience"},
		{"audience string form, wrong value", func(c map[string]any) { c["aud"] = "account" }, "audience"},
		{"expired", func(c map[string]any) { c["exp"] = clock.Now().Add(-2 * time.Minute).Unix() }, "expired"},
		{"not yet valid", func(c map[string]any) { c["nbf"] = clock.Now().Add(10 * time.Minute).Unix() }, "not valid before"},
		{"issued in the future", func(c map[string]any) { c["iat"] = clock.Now().Add(10 * time.Minute).Unix() }, "future"},
		{"no exp", func(c map[string]any) { delete(c, "exp") }, "no exp"},
		{"no subject", func(c map[string]any) { delete(c, "sub") }, "no subject"},
		{"refresh token", func(c map[string]any) { c["typ"] = "Refresh" }, "refresh token"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			claims := claimSet(i.issuer(), clock.Now())
			tc.mutate(claims)
			_, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims))
			if !errors.Is(err, domain.ErrUnauthorized) {
				t.Fatalf("err = %v, want ErrUnauthorized", err)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("err = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

// A refresh token is signed by the same realm key as an access token, so only
// `typ` separates them — and Keycloak puts it in the header as well.
func TestVerifyTokenRejectsRefreshTypInTheHeader(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	header := rsaHeader()
	header["typ"] = "Refresh"
	claims := claimSet(i.issuer(), clock.Now())
	delete(claims, "typ")

	_, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), header, claims))
	if !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestVerifyTokenAcceptsAudienceAsAString(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	claims := claimSet(i.issuer(), clock.Now())
	claims["aud"] = testAudience
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); err != nil {
		t.Fatalf("VerifyToken with a string aud: %v", err)
	}
}

func TestVerifyTokenRejectsTamperedTokens(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)
	valid := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))

	// Re-encode the payload with an escalated subject, keeping the original
	// signature: the attack a verifier that skips the signature check permits.
	forged := claimSet(i.issuer(), clock.Now())
	forged["sub"] = "someone-else"
	swapped := strings.Split(valid, ".")
	swapped[1] = segment(t, forged)

	tests := []struct {
		name  string
		token string
	}{
		{"flipped signature byte", tamperSignature(t, valid)},
		{"payload swapped under the signature", strings.Join(swapped, ".")},
		{"signed by a key the idp does not publish", signRSA(t, foreignKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))},
		{"signature removed", strings.Join(strings.Split(valid, ".")[:2], ".") + "."},
		{"not a jws", "not-a-token"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := v.VerifyToken(context.Background(), tc.token); !errors.Is(err, domain.ErrUnauthorized) {
				t.Fatalf("err = %v, want ErrUnauthorized", err)
			}
		})
	}
}

// The two classic JWT breaks: drop the signature, or convince the verifier that
// the public key is an HMAC secret.
func TestVerifyTokenRejectsUnsignedAndSymmetricAlgorithms(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)
	claims := claimSet(i.issuer(), clock.Now())

	unsigned := func(alg string) string {
		return segment(t, map[string]any{"alg": alg, "typ": "JWT", "kid": testKID}) + "." + segment(t, claims) + "."
	}

	// The attacker's HMAC secret is the only key material they have: ours.
	pubDER, err := x509.MarshalPKIXPublicKey(&signingKey().PublicKey)
	if err != nil {
		t.Fatalf("marshal public key: %v", err)
	}
	hs256 := func(secret []byte) string {
		signing := segment(t, map[string]any{"alg": "HS256", "typ": "JWT", "kid": testKID}) + "." + segment(t, claims)
		mac := hmac.New(sha256.New, secret)
		mac.Write([]byte(signing))
		return signing + "." + b64(mac.Sum(nil))
	}

	tests := []struct {
		name  string
		token string
	}{
		{"alg none", unsigned("none")},
		{"alg None", unsigned("None")},
		{"alg empty", unsigned("")},
		{"hs256 keyed with the public key DER", hs256(pubDER)},
		{"hs256 keyed with the modulus", hs256(signingKey().PublicKey.N.Bytes())},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := v.VerifyToken(context.Background(), tc.token); !errors.Is(err, domain.ErrUnauthorized) {
				t.Fatalf("err = %v, want ErrUnauthorized", err)
			}
		})
	}
}

// An unknown kid is attacker-controlled input: it must refresh once (rotation
// is real) and then stop, so a flood of forged headers cannot be aimed at the
// IdP through us.
func TestUnknownKidRefreshesOnceThenIsRateLimited(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); err != nil {
		t.Fatalf("valid token: %v", err)
	}
	jwks, _ := i.hits()
	if jwks != 1 {
		t.Fatalf("jwks fetches after the first token = %d, want 1", jwks)
	}

	clock.advance(31 * time.Second) // past the refresh cooldown

	bogus := rsaHeader()
	bogus["kid"] = "kid-that-does-not-exist"
	token := signRSA(t, signingKey(), bogus, claimSet(i.issuer(), clock.Now()))

	if _, err := v.VerifyToken(context.Background(), token); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
	if jwks, _ := i.hits(); jwks != 2 {
		t.Fatalf("jwks fetches after one unknown kid = %d, want 2", jwks)
	}

	for n := 0; n < 20; n++ {
		if _, err := v.VerifyToken(context.Background(), token); !errors.Is(err, domain.ErrUnauthorized) {
			t.Fatalf("err = %v, want ErrUnauthorized", err)
		}
	}
	if jwks, _ := i.hits(); jwks != 2 {
		t.Errorf("jwks fetches after a flood of unknown kids = %d, want 2 (rate limited)", jwks)
	}

	// Once the cooldown passes, a genuine rotation is picked up.
	rotated := genRSA()
	i.setKeys(rsaJWK("kid-that-does-not-exist", &rotated.PublicKey, "RS256", "sig"))
	clock.advance(31 * time.Second)
	rotatedToken := signRSA(t, rotated, bogus, claimSet(i.issuer(), clock.Now()))
	if _, err := v.VerifyToken(context.Background(), rotatedToken); err != nil {
		t.Fatalf("token signed with the rotated key: %v", err)
	}
}

// Keycloak boots slower than Lura, so construction must succeed against a dead
// discovery endpoint and pick the keys up later.
func TestDiscoveryIsRetriedWhenTheIdPIsNotUpYet(t *testing.T) {
	i := defaultIDP(t)
	i.setUp(false)
	clock := newClock()

	v := newVerifier(t, i, clock) // must not fail: the server has to boot anyway
	if _, discovery := i.hits(); discovery == 0 {
		t.Error("constructor did not attempt discovery")
	}

	tok := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))
	if _, err := v.VerifyToken(context.Background(), tok); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err with the idp down = %v, want ErrUnauthorized", err)
	}

	i.setUp(true)
	clock.advance(31 * time.Second) // past the cooldown on the failed attempt

	claims, err := v.VerifyToken(context.Background(), tok)
	if err != nil {
		t.Fatalf("VerifyToken once the idp is up: %v", err)
	}
	if claims.Subject != testSubject {
		t.Errorf("Subject = %q, want %q", claims.Subject, testSubject)
	}
}

// A configured JWKS URL skips discovery entirely.
func TestExplicitJWKSURLSkipsDiscovery(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()

	v, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		Issuer:     i.issuer(),
		Audience:   testAudience,
		JWKSURL:    i.srv.URL + "/realms/lura/protocol/openid-connect/certs",
		HTTPClient: i.srv.Client(),
		Clock:      clock.Now,
	})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if _, discovery := i.hits(); discovery != 0 {
		t.Errorf("discovery requests = %d, want 0", discovery)
	}
}

// A discovery document naming another realm means the config points somewhere
// unintended; verifying against those keys would be worse than failing.
func TestDiscoveryIssuerMismatchIsRejected(t *testing.T) {
	i := newIDP(t, rsaJWK(testKID, &signingKey().PublicKey, "RS256", "sig"))
	clock := newClock()

	v, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		// Same host, different realm: discovery answers for /realms/lura.
		Issuer:     i.srv.URL + "/realms/lura/",
		Audience:   testAudience,
		HTTPClient: i.srv.Client(),
		Clock:      clock.Now,
	})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}
	// The trailing slash in the configured issuer is trimmed, so this one works.
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); err != nil {
		t.Fatalf("VerifyToken with a trailing-slash issuer: %v", err)
	}

	imposter, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		Issuer:     i.srv.URL + "/realms/imposter",
		Audience:   testAudience,
		HTTPClient: i.srv.Client(),
		Clock:      clock.Now,
	})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}
	_, err = imposter.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.srv.URL+"/realms/imposter", clock.Now())))
	if !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
	if !strings.Contains(err.Error(), "declares issuer") {
		t.Errorf("err = %q, want it to name the issuer mismatch", err)
	}
}

func TestES256TokensAreAccepted(t *testing.T) {
	i := newIDP(t, ecJWK(testKID, &ecKey().PublicKey))
	clock := newClock()
	v := newVerifier(t, i, clock)

	claims, err := v.VerifyToken(context.Background(), signES256(t, ecKey(), testKID, claimSet(i.issuer(), clock.Now())))
	if err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}
	if claims.Subject != testSubject {
		t.Errorf("Subject = %q, want %q", claims.Subject, testSubject)
	}

	// An RS256 token cannot borrow an EC key, and vice versa.
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); !errors.Is(err, domain.ErrUnauthorized) {
		t.Errorf("RS256 token against an EC key: err = %v, want ErrUnauthorized", err)
	}
}

func TestRS384AndRS512AreAccepted(t *testing.T) {
	for _, alg := range []string{"RS384", "RS512"} {
		t.Run(alg, func(t *testing.T) {
			// The JWK pins no alg, so the key may verify either variant.
			i := newIDP(t, rsaJWK(testKID, &signingKey().PublicKey, "", "sig"))
			clock := newClock()
			v := newVerifier(t, i, clock)

			header := rsaHeader()
			header["alg"] = alg
			if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), header, claimSet(i.issuer(), clock.Now()))); err != nil {
				t.Fatalf("VerifyToken: %v", err)
			}
		})
	}
}

// The JWK's own alg is a constraint, not decoration.
func TestTokenAlgMustMatchThePublishedKeyAlg(t *testing.T) {
	i := newIDP(t, rsaJWK(testKID, &signingKey().PublicKey, "RS256", "sig"))
	clock := newClock()
	v := newVerifier(t, i, clock)

	header := rsaHeader()
	header["alg"] = "RS512"
	_, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), header, claimSet(i.issuer(), clock.Now())))
	if !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

// Keycloak publishes an RSA-OAEP encryption key in the same JWKS; a token
// signed with it must not verify.
func TestEncryptionKeysAreNotUsedForVerification(t *testing.T) {
	i := newIDP(t,
		rsaJWK(testKID, &signingKey().PublicKey, "RS256", "sig"),
		rsaJWK("enc-1", &foreignKey().PublicKey, "RSA-OAEP", "enc"),
	)
	clock := newClock()
	v := newVerifier(t, i, clock)

	header := rsaHeader()
	header["kid"] = "enc-1"
	if _, err := v.VerifyToken(context.Background(), signRSA(t, foreignKey(), header, claimSet(i.issuer(), clock.Now()))); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestLeewayAbsorbsClockSkew(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		Issuer:     i.issuer(),
		Audience:   testAudience,
		HTTPClient: i.srv.Client(),
		Clock:      clock.Now,
		Leeway:     30 * time.Second,
	})
	if err != nil {
		t.Fatalf("NewOIDC: %v", err)
	}

	claims := claimSet(i.issuer(), clock.Now())
	claims["exp"] = clock.Now().Add(-20 * time.Second).Unix() // just inside the leeway
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); err != nil {
		t.Fatalf("token expired inside the leeway: %v", err)
	}

	claims["exp"] = clock.Now().Add(-40 * time.Second).Unix() // just outside
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); !errors.Is(err, domain.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

// The IdP going down after boot must not log everyone out: a stale key still
// verifies tokens the IdP already issued.
func TestCachedKeysSurviveAnIdPOutage(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))); err != nil {
		t.Fatalf("VerifyToken: %v", err)
	}

	i.setUp(false)
	clock.advance(30 * time.Minute) // past the cache TTL

	claims := claimSet(i.issuer(), clock.Now())
	if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); err != nil {
		t.Fatalf("VerifyToken with the idp down and a stale cache: %v", err)
	}
}

func TestNewOIDCRejectsUnusableConfig(t *testing.T) {
	tests := []struct {
		name string
		cfg  auth.OIDCConfig
	}{
		{"no issuer", auth.OIDCConfig{Audience: testAudience}},
		{"relative issuer", auth.OIDCConfig{Issuer: "/realms/lura", Audience: testAudience}},
		{"non-http issuer", auth.OIDCConfig{Issuer: "ldap://idp.example/realms/lura", Audience: testAudience}},
		{"no audience", auth.OIDCConfig{Issuer: "https://idp.example/realms/lura"}},
		{"negative leeway", auth.OIDCConfig{Issuer: "https://idp.example/realms/lura", Audience: testAudience, Leeway: -time.Second}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := auth.NewOIDC(context.Background(), tc.cfg); !errors.Is(err, domain.ErrInvalid) {
				t.Fatalf("err = %v, want ErrInvalid", err)
			}
		})
	}
}

// Concurrent verification is the normal case; one refresh must serve all of it.
func TestConcurrentVerificationSharesOneRefresh(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)
	tok := signRSA(t, signingKey(), rsaHeader(), claimSet(i.issuer(), clock.Now()))

	var wg sync.WaitGroup
	errs := make([]error, 16)
	for n := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[n] = v.VerifyToken(context.Background(), tok)
		}()
	}
	wg.Wait()

	for n, err := range errs {
		if err != nil {
			t.Fatalf("goroutine %d: %v", n, err)
		}
	}
	if jwks, _ := i.hits(); jwks != 1 {
		t.Errorf("jwks fetches = %d, want 1", jwks)
	}
}

// tamperSignature flips a bit in the decoded signature. Flipping a character of
// the encoded segment is not enough: the last base64 character carries padding
// bits the decoder discards, so the signature can survive it unchanged.
func tamperSignature(t *testing.T, token string) string {
	t.Helper()
	parts := strings.Split(token, ".")
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatalf("decode signature: %v", err)
	}
	sig[0] ^= 0x01
	parts[2] = b64(sig)
	return strings.Join(parts, ".")
}
