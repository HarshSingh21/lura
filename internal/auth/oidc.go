// OIDC access-token verification (HLD §16, Phase 2: "static bearer → IdP JWT").
//
// The IdP is Keycloak, but nothing here is Keycloak-specific beyond the claim
// names it populates: discovery, JWKS and compact JWS are the standards every
// OIDC provider speaks.
//
// Two properties shaped this file:
//
//   - Booting must not depend on the IdP. Lura and Keycloak come up together in
//     one compose file, and Keycloak is the slower of the two. Discovery is
//     attempted at construction and *retried lazily* if it fails, so a slow
//     dependency delays the first login rather than stopping the server.
//   - Key lookups are attacker-triggered. Any request can name an arbitrary
//     `kid`, so an unknown-kid refresh is rate-limited: a flood of forged
//     headers must not turn Lura into a load generator pointed at Keycloak.
//
// Verification is implemented on the standard library rather than a JWT
// dependency: a compact JWS is two base64url segments, a signature and an
// allowlist of algorithms. The allowlist is the security-critical half — a
// verifier that honours the token's own `alg` can be handed "none", or an HS256
// token signed with the public key as the HMAC secret, and will happily agree.

package auth

import (
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
)

const (
	// defaultLeeway absorbs clock skew between Lura and the IdP. Both are
	// expected to run NTP; a minute is generous without making an expired token
	// meaningfully useful.
	defaultLeeway = 60 * time.Second

	// defaultCacheTTL is how long a fetched JWKS is served without re-asking.
	// Rotation is still picked up faster than this: an unknown kid forces a
	// refresh, which is exactly what a rotation looks like from here.
	defaultCacheTTL = 10 * time.Minute

	// refreshCooldown bounds IdP traffic. Every JWKS fetch — including the one
	// behind an unknown kid — goes through it, so the worst a forged-kid flood
	// can do is two HTTP requests per cooldown window (discovery + JWKS).
	refreshCooldown = 30 * time.Second

	// discoveryTimeout caps the boot-time discovery attempt. Failing it is fine;
	// blocking on it is not.
	discoveryTimeout = 5 * time.Second

	// maxDocBytes caps discovery/JWKS bodies. The IdP is trusted, but "trusted"
	// and "allowed to stream us an unbounded body" are different things.
	maxDocBytes = 1 << 20
)

// OIDCConfig configures an OIDCVerifier.
type OIDCConfig struct {
	// Issuer is the realm URL, e.g. http://localhost:8085/realms/lura. It must
	// equal the token's `iss` exactly (a trailing slash is trimmed from both).
	Issuer string
	// Audience must appear in the token's `aud`. Required: an access token that
	// is not addressed to this API is one that was minted for someone else.
	Audience string
	// JWKSURL short-circuits discovery. Empty means "learn it from
	// <issuer>/.well-known/openid-configuration".
	JWKSURL string
	// HTTPClient talks to the IdP. Defaults to a 10s-timeout client.
	HTTPClient *http.Client
	// Clock overrides time.Now (tests).
	Clock func() time.Time
	// Leeway tolerates clock skew on exp/nbf/iat. Defaults to defaultLeeway.
	Leeway time.Duration
	// CacheTTL is how long the JWKS is cached. Defaults to defaultCacheTTL.
	CacheTTL time.Duration
}

// Claims is the verified content of an access token, narrowed to what Lura
// actually uses: an identity to key on, plus the human-facing claims that let
// the API layer provision a domain.User on first login without a second call to
// the IdP's userinfo endpoint.
type Claims struct {
	Subject       string // `sub` — stable, opaque, becomes Principal.UserID
	Username      string // `preferred_username`
	Email         string
	EmailVerified bool
	Name          string
	Roles         []string // `realm_access.roles`
	Issuer        string
	Audience      []string
	ExpiresAt     time.Time
	IssuedAt      time.Time
}

// HasRole reports whether the token carries a realm role.
func (c Claims) HasRole(role string) bool {
	for _, r := range c.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// OIDCVerifier authenticates control-plane requests with IdP-issued access
// tokens. It is safe for concurrent use.
type OIDCVerifier struct {
	issuer   string
	audience string
	client   *http.Client
	now      func() time.Time
	leeway   time.Duration
	cacheTTL time.Duration

	// fetchMu serializes IdP calls, so a burst of misses produces one fetch
	// rather than one per goroutine.
	fetchMu sync.Mutex

	mu          sync.RWMutex
	jwksURL     string
	keys        map[string]verifyKey
	fetchedAt   time.Time // last successful JWKS fetch
	lastAttempt time.Time // last fetch attempt, successful or not — the rate limit
}

// verifyKey is one usable signing key from the JWKS.
type verifyKey struct {
	pub crypto.PublicKey
	// alg is the algorithm the IdP pinned to this key, or "" if it published
	// none. When set, a token must match it: a key advertised for RS256 has no
	// business verifying anything else.
	alg string
}

// NewOIDC builds a verifier.
//
// It never fails because the IdP is unreachable — only because the
// configuration itself is unusable. Discovery is attempted here so the common
// case (IdP already up) has a warm verifier, and retried on demand otherwise.
func NewOIDC(ctx context.Context, cfg OIDCConfig) (*OIDCVerifier, error) {
	// Trim the trailing slash on both sides of the issuer comparison: operators
	// paste URLs with and without it, and Keycloak's `iss` never has one.
	issuer := strings.TrimRight(strings.TrimSpace(cfg.Issuer), "/")
	if issuer == "" {
		return nil, fmt.Errorf("oidc: issuer required: %w", domain.ErrInvalid)
	}
	u, err := url.Parse(issuer)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return nil, fmt.Errorf("oidc: issuer %q is not an absolute http(s) URL: %w", cfg.Issuer, domain.ErrInvalid)
	}
	audience := strings.TrimSpace(cfg.Audience)
	if audience == "" {
		// Optional audience checking is how a token minted for the admin console
		// ends up accepted here, so it is not offered.
		return nil, fmt.Errorf("oidc: audience required: %w", domain.ErrInvalid)
	}
	if cfg.Leeway < 0 || cfg.CacheTTL < 0 {
		return nil, fmt.Errorf("oidc: leeway and cacheTTL must not be negative: %w", domain.ErrInvalid)
	}

	v := &OIDCVerifier{
		issuer:   issuer,
		audience: audience,
		client:   cfg.HTTPClient,
		now:      cfg.Clock,
		leeway:   cfg.Leeway,
		cacheTTL: cfg.CacheTTL,
		jwksURL:  strings.TrimSpace(cfg.JWKSURL),
		keys:     map[string]verifyKey{},
	}
	if v.client == nil {
		v.client = &http.Client{Timeout: 10 * time.Second}
	}
	if v.now == nil {
		v.now = time.Now
	}
	if v.leeway == 0 {
		v.leeway = defaultLeeway
	}
	if v.cacheTTL == 0 {
		v.cacheTTL = defaultCacheTTL
	}

	if v.jwksURL == "" {
		dctx, cancel := context.WithTimeout(ctx, discoveryTimeout)
		defer cancel()
		if jwksURL, err := v.discover(dctx); err == nil {
			v.jwksURL = jwksURL
		}
		// Otherwise: the IdP is not up yet. Leave jwksURL empty; the first token
		// to arrive will discover it.
	}
	return v, nil
}

// Authenticate implements Authenticator.
func (v *OIDCVerifier) Authenticate(r *http.Request) (Principal, error) {
	p, _, err := v.VerifyRequest(r)
	return p, err
}

// VerifyRequest is Authenticate plus the claims, for callers that provision a
// local user record from the token (display name, email) on first sight.
func (v *OIDCVerifier) VerifyRequest(r *http.Request) (Principal, Claims, error) {
	raw := BearerToken(r)
	if raw == "" {
		return Principal{}, Claims{}, fmt.Errorf("oidc: missing bearer token: %w", domain.ErrUnauthorized)
	}
	claims, err := v.VerifyToken(r.Context(), raw)
	if err != nil {
		return Principal{}, Claims{}, err
	}
	return Principal{Kind: KindUser, UserID: claims.Subject}, claims, nil
}

// VerifyToken checks a compact JWS access token and returns its claims. Every
// failure wraps domain.ErrUnauthorized so the API layer answers 401 without
// having to know why — the detail is for the log, not the client.
func (v *OIDCVerifier) VerifyToken(ctx context.Context, raw string) (Claims, error) {
	parts := strings.Split(raw, ".")
	if len(parts) != 3 {
		return Claims{}, fmt.Errorf("oidc: not a compact JWS (%d segments): %w", len(parts), domain.ErrUnauthorized)
	}

	headerJSON, err := decodeSegment(parts[0])
	if err != nil {
		return Claims{}, fmt.Errorf("oidc: header: %w", errUnauthorized(err))
	}
	var hdr struct {
		Alg string `json:"alg"`
		Kid string `json:"kid"`
		Typ string `json:"typ"`
	}
	if err := json.Unmarshal(headerJSON, &hdr); err != nil {
		return Claims{}, fmt.Errorf("oidc: header: %w", errUnauthorized(err))
	}

	// Algorithm allowlist, applied before a key is even looked up. "none"
	// removes the signature; HS* invites the verifier to treat a public value as
	// a shared secret. Neither is a mistake we get to make twice.
	switch hdr.Alg {
	case "RS256", "RS384", "RS512", "ES256":
	case "", "none", "None", "NONE":
		return Claims{}, fmt.Errorf("oidc: unsigned token (alg %q): %w", hdr.Alg, domain.ErrUnauthorized)
	default:
		return Claims{}, fmt.Errorf("oidc: unsupported signing algorithm %q: %w", hdr.Alg, domain.ErrUnauthorized)
	}
	if hdr.Kid == "" {
		// Every OIDC provider that rotates keys publishes a kid, and picking a
		// key by trial defeats the point of naming one.
		return Claims{}, fmt.Errorf("oidc: token header has no kid: %w", domain.ErrUnauthorized)
	}
	// Keycloak types its tokens: "Bearer"/"JWT" for access tokens, "Refresh" for
	// refresh tokens, which are signed by the same realm keys and would
	// otherwise verify perfectly.
	if strings.EqualFold(hdr.Typ, "refresh") {
		return Claims{}, fmt.Errorf("oidc: refresh token presented as an access token: %w", domain.ErrUnauthorized)
	}

	sig, err := decodeSegment(parts[2])
	if err != nil {
		return Claims{}, fmt.Errorf("oidc: signature: %w", errUnauthorized(err))
	}

	key, err := v.keyFor(ctx, hdr.Kid)
	if err != nil {
		return Claims{}, err
	}
	if key.alg != "" && key.alg != hdr.Alg {
		return Claims{}, fmt.Errorf("oidc: key %s is published for %s, token uses %s: %w", hdr.Kid, key.alg, hdr.Alg, domain.ErrUnauthorized)
	}
	signed := []byte(parts[0] + "." + parts[1])
	if err := verifySignature(key, hdr.Alg, signed, sig); err != nil {
		return Claims{}, fmt.Errorf("oidc: signature: %w", errUnauthorized(err))
	}

	payload, err := decodeSegment(parts[1])
	if err != nil {
		return Claims{}, fmt.Errorf("oidc: payload: %w", errUnauthorized(err))
	}
	var body tokenClaims
	if err := json.Unmarshal(payload, &body); err != nil {
		return Claims{}, fmt.Errorf("oidc: payload: %w", errUnauthorized(err))
	}
	return v.validate(body)
}

// validate applies the claim checks. The signature only proves the IdP wrote
// the token; these checks prove it wrote it for us, now.
func (v *OIDCVerifier) validate(c tokenClaims) (Claims, error) {
	if got := strings.TrimRight(c.Issuer, "/"); got != v.issuer {
		return Claims{}, fmt.Errorf("oidc: issuer %q, want %q: %w", c.Issuer, v.issuer, domain.ErrUnauthorized)
	}
	if !containsString(c.Audience, v.audience) {
		return Claims{}, fmt.Errorf("oidc: audience %v does not include %q: %w", []string(c.Audience), v.audience, domain.ErrUnauthorized)
	}
	if c.Subject == "" {
		return Claims{}, fmt.Errorf("oidc: token has no subject: %w", domain.ErrUnauthorized)
	}
	if strings.EqualFold(c.Typ, "refresh") {
		return Claims{}, fmt.Errorf("oidc: refresh token presented as an access token: %w", domain.ErrUnauthorized)
	}

	now := v.now()
	// exp is required. A token that never expires is a password with worse
	// rotation properties.
	if !c.Expiry.set {
		return Claims{}, fmt.Errorf("oidc: token has no exp: %w", domain.ErrUnauthorized)
	}
	if !now.Add(-v.leeway).Before(c.Expiry.t) {
		return Claims{}, fmt.Errorf("oidc: token expired at %s: %w", c.Expiry.t.Format(time.RFC3339), domain.ErrUnauthorized)
	}
	if c.NotBefore.set && now.Add(v.leeway).Before(c.NotBefore.t) {
		return Claims{}, fmt.Errorf("oidc: token not valid before %s: %w", c.NotBefore.t.Format(time.RFC3339), domain.ErrUnauthorized)
	}
	if c.IssuedAt.set && now.Add(v.leeway).Before(c.IssuedAt.t) {
		return Claims{}, fmt.Errorf("oidc: token issued in the future (%s): %w", c.IssuedAt.t.Format(time.RFC3339), domain.ErrUnauthorized)
	}

	return Claims{
		Subject:       c.Subject,
		Username:      c.PreferredUsername,
		Email:         c.Email,
		EmailVerified: bool(c.EmailVerified),
		Name:          c.Name,
		Roles:         c.RealmAccess.Roles,
		Issuer:        c.Issuer,
		Audience:      c.Audience,
		ExpiresAt:     c.Expiry.t,
		IssuedAt:      c.IssuedAt.t,
	}, nil
}

// keyFor resolves a kid to a verification key, refreshing the JWKS when the kid
// is unknown or the cache has aged out.
func (v *OIDCVerifier) keyFor(ctx context.Context, kid string) (verifyKey, error) {
	if key, fresh, ok := v.lookup(kid); ok && fresh {
		return key, nil
	}
	refreshErr := v.refresh(ctx)
	// Look again regardless of the outcome: a concurrent refresh may have landed
	// the key, and a stale-but-present key beats a 401 for every user while the
	// IdP is briefly unreachable.
	if key, _, ok := v.lookup(kid); ok {
		return key, nil
	}
	if refreshErr != nil {
		return verifyKey{}, fmt.Errorf("oidc: no key %s (%v): %w", kid, refreshErr, domain.ErrUnauthorized)
	}
	return verifyKey{}, fmt.Errorf("oidc: unknown key id %s: %w", kid, domain.ErrUnauthorized)
}

// lookup reports the cached key for kid and whether the cache is still fresh.
func (v *OIDCVerifier) lookup(kid string) (key verifyKey, fresh, ok bool) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	key, ok = v.keys[kid]
	fresh = !v.fetchedAt.IsZero() && v.now().Sub(v.fetchedAt) < v.cacheTTL
	return key, fresh, ok
}

// refresh re-reads the JWKS, at most once per refreshCooldown across all
// callers. It replaces the key set wholesale so a revoked key stops verifying.
func (v *OIDCVerifier) refresh(ctx context.Context) error {
	v.fetchMu.Lock()
	defer v.fetchMu.Unlock()

	v.mu.RLock()
	last, jwksURL := v.lastAttempt, v.jwksURL
	v.mu.RUnlock()

	now := v.now()
	if !last.IsZero() && now.Sub(last) < refreshCooldown {
		return fmt.Errorf("jwks refresh rate-limited, last attempt %s ago", now.Sub(last).Truncate(time.Second))
	}

	v.mu.Lock()
	v.lastAttempt = now
	v.mu.Unlock()

	if jwksURL == "" {
		discovered, err := v.discover(ctx)
		if err != nil {
			return err
		}
		jwksURL = discovered
		v.mu.Lock()
		v.jwksURL = discovered
		v.mu.Unlock()
	}

	var doc struct {
		Keys []jsonWebKey `json:"keys"`
	}
	if err := v.getJSON(ctx, jwksURL, &doc); err != nil {
		return err
	}
	keys := make(map[string]verifyKey, len(doc.Keys))
	for _, k := range doc.Keys {
		pub, err := k.publicKey()
		if err != nil || k.Kid == "" {
			// Keycloak publishes an RSA-OAEP encryption key next to the signing
			// key; unusable entries are skipped, not fatal.
			continue
		}
		keys[k.Kid] = verifyKey{pub: pub, alg: k.Alg}
	}
	if len(keys) == 0 {
		return fmt.Errorf("jwks at %s has no usable signing key", jwksURL)
	}

	v.mu.Lock()
	v.keys = keys
	v.fetchedAt = now
	v.mu.Unlock()
	return nil
}

// discover reads the OIDC discovery document and returns its jwks_uri.
func (v *OIDCVerifier) discover(ctx context.Context) (string, error) {
	endpoint := v.issuer + "/.well-known/openid-configuration"
	var doc struct {
		Issuer  string `json:"issuer"`
		JWKSURI string `json:"jwks_uri"`
	}
	if err := v.getJSON(ctx, endpoint, &doc); err != nil {
		return "", err
	}
	// The discovery document is fetched from the issuer URL, so a mismatch means
	// the configuration points at the wrong realm — refuse rather than silently
	// verify against another realm's keys.
	if strings.TrimRight(doc.Issuer, "/") != v.issuer {
		return "", fmt.Errorf("discovery at %s declares issuer %q, want %q", endpoint, doc.Issuer, v.issuer)
	}
	if doc.JWKSURI == "" {
		return "", fmt.Errorf("discovery at %s has no jwks_uri", endpoint)
	}
	return doc.JWKSURI, nil
}

func (v *OIDCVerifier) getJSON(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := v.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("GET %s: %s", endpoint, resp.Status)
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxDocBytes)).Decode(out); err != nil {
		return fmt.Errorf("GET %s: %w", endpoint, err)
	}
	return nil
}

// verifySignature checks sig over signed with the algorithm the caller already
// allowlisted.
func verifySignature(key verifyKey, alg string, signed, sig []byte) error {
	switch alg {
	case "RS256", "RS384", "RS512":
		pub, ok := key.pub.(*rsa.PublicKey)
		if !ok {
			return fmt.Errorf("%s token verified against a non-RSA key", alg)
		}
		h, id := hashFor(alg)
		h.Write(signed)
		return rsa.VerifyPKCS1v15(pub, id, h.Sum(nil), sig)

	case "ES256":
		pub, ok := key.pub.(*ecdsa.PublicKey)
		if !ok {
			return fmt.Errorf("%s token verified against a non-EC key", alg)
		}
		if pub.Curve != elliptic.P256() {
			return fmt.Errorf("ES256 requires P-256, key is %s", pub.Curve.Params().Name)
		}
		// JWS ECDSA signatures are the fixed-width r||s pair, not the ASN.1 DER
		// encoding crypto/ecdsa emits by default.
		if len(sig) != 64 {
			return fmt.Errorf("ES256 signature is %d bytes, want 64", len(sig))
		}
		sum := sha256.Sum256(signed)
		r := new(big.Int).SetBytes(sig[:32])
		s := new(big.Int).SetBytes(sig[32:])
		if !ecdsa.Verify(pub, sum[:], r, s) {
			return fmt.Errorf("ES256 signature mismatch")
		}
		return nil
	}
	return fmt.Errorf("unsupported algorithm %q", alg)
}

func hashFor(alg string) (hash.Hash, crypto.Hash) {
	switch alg {
	case "RS384":
		return sha512.New384(), crypto.SHA384
	case "RS512":
		return sha512.New(), crypto.SHA512
	default:
		return sha256.New(), crypto.SHA256
	}
}

// jsonWebKey is the subset of RFC 7517 Lura can verify with.
type jsonWebKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
	Crv string `json:"crv"`
	X   string `json:"x"`
	Y   string `json:"y"`
}

// publicKey converts a JWK to a crypto key, rejecting anything that cannot
// verify a Lura access token.
func (k jsonWebKey) publicKey() (crypto.PublicKey, error) {
	if k.Use != "" && k.Use != "sig" {
		return nil, fmt.Errorf("key %s is for %q, not signing", k.Kid, k.Use)
	}
	switch k.Kty {
	case "RSA":
		n, err := decodeSegment(k.N)
		if err != nil {
			return nil, fmt.Errorf("key %s: modulus: %w", k.Kid, err)
		}
		e, err := decodeSegment(k.E)
		if err != nil {
			return nil, fmt.Errorf("key %s: exponent: %w", k.Kid, err)
		}
		if len(e) == 0 || len(e) > 8 {
			return nil, fmt.Errorf("key %s: exponent out of range", k.Kid)
		}
		modulus := new(big.Int).SetBytes(n)
		// Anything under 2048 bits is forgeable enough to matter, and no OIDC
		// provider worth trusting publishes one.
		if modulus.BitLen() < 2048 {
			return nil, fmt.Errorf("key %s: %d-bit RSA modulus is too small", k.Kid, modulus.BitLen())
		}
		return &rsa.PublicKey{N: modulus, E: int(new(big.Int).SetBytes(e).Int64())}, nil

	case "EC":
		if k.Crv != "P-256" {
			return nil, fmt.Errorf("key %s: curve %q unsupported", k.Kid, k.Crv)
		}
		x, err := decodeSegment(k.X)
		if err != nil {
			return nil, fmt.Errorf("key %s: x: %w", k.Kid, err)
		}
		y, err := decodeSegment(k.Y)
		if err != nil {
			return nil, fmt.Errorf("key %s: y: %w", k.Kid, err)
		}
		pub := &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
		if !pub.Curve.IsOnCurve(pub.X, pub.Y) {
			return nil, fmt.Errorf("key %s: point is not on P-256", k.Kid)
		}
		return pub, nil
	}
	// Notably absent: "oct". A symmetric key in a JWKS is either a mistake or an
	// invitation to verify HS256 tokens anyone can mint.
	return nil, fmt.Errorf("key %s: unsupported key type %q", k.Kid, k.Kty)
}

// tokenClaims is the wire shape of the payload, with the Keycloak claims Lura
// provisions users from.
type tokenClaims struct {
	Issuer            string      `json:"iss"`
	Subject           string      `json:"sub"`
	Audience          audience    `json:"aud"`
	Expiry            numericDate `json:"exp"`
	NotBefore         numericDate `json:"nbf"`
	IssuedAt          numericDate `json:"iat"`
	Typ               string      `json:"typ"`
	PreferredUsername string      `json:"preferred_username"`
	Email             string      `json:"email"`
	EmailVerified     lenientBool `json:"email_verified"`
	Name              string      `json:"name"`
	RealmAccess       struct {
		Roles []string `json:"roles"`
	} `json:"realm_access"`
}

// audience is `aud`, which RFC 7519 allows to be either a string or an array of
// strings.
type audience []string

func (a *audience) UnmarshalJSON(b []byte) error {
	var one string
	if err := json.Unmarshal(b, &one); err == nil {
		*a = audience{one}
		return nil
	}
	var many []string
	if err := json.Unmarshal(b, &many); err != nil {
		return fmt.Errorf("aud must be a string or an array of strings")
	}
	*a = many
	return nil
}

// numericDate is a JWT timestamp: seconds since the epoch, possibly fractional.
// `set` distinguishes "absent" from "the epoch", which matters for exp.
type numericDate struct {
	t   time.Time
	set bool
}

func (d *numericDate) UnmarshalJSON(b []byte) error {
	if string(b) == "null" {
		return nil
	}
	secs, err := strconv.ParseFloat(string(b), 64)
	if err != nil {
		return fmt.Errorf("not a numeric date: %s", b)
	}
	d.t = time.Unix(int64(secs), 0).UTC()
	d.set = true
	return nil
}

// lenientBool decodes `email_verified` from either a bool or a quoted bool.
// Some providers render it as a string, and a token rejected over the shape of
// an advisory claim is a 401 nobody can debug. Anything unrecognised degrades
// to false — this claim is provisioning metadata, never an access decision.
type lenientBool bool

func (l *lenientBool) UnmarshalJSON(b []byte) error {
	var flag bool
	if err := json.Unmarshal(b, &flag); err == nil {
		*l = lenientBool(flag)
		return nil
	}
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		if parsed, err := strconv.ParseBool(s); err == nil {
			*l = lenientBool(parsed)
		}
	}
	return nil
}

// decodeSegment decodes base64url, tolerating the padding some encoders add.
func decodeSegment(s string) ([]byte, error) {
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		return nil, fmt.Errorf("invalid base64url")
	}
	return b, nil
}

func containsString(list []string, want string) bool {
	for _, s := range list {
		if s == want {
			return true
		}
	}
	return false
}

// errUnauthorized keeps the underlying detail readable in logs while making the
// error match domain.ErrUnauthorized for the API layer's status mapping.
func errUnauthorized(err error) error {
	return fmt.Errorf("%v: %w", err, domain.ErrUnauthorized)
}

var _ Authenticator = (*OIDCVerifier)(nil)
