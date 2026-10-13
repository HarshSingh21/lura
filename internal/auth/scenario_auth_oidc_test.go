package auth_test

import (
	"context"
	"errors"
	"testing"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// An ID token is signed by the same realm keys as an access token and, with an
// audience mapper that also writes to ID tokens, can carry aud=lura-api. Only
// `typ` tells them apart, and docs/auth.md §3 (check 6) requires "Bearer".
func TestVerifyTokenRejectsTokensThatAreNotAccessTokens(t *testing.T) {
	i := defaultIDP(t)
	clock := newClock()
	v := newVerifier(t, i, clock)

	for _, typ := range []string{"ID", "Logout", "Offline"} {
		claims := claimSet(i.issuer(), clock.Now())
		claims["typ"] = typ
		if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); !errors.Is(err, domain.ErrUnauthorized) {
			t.Errorf("typ %q: err = %v, want ErrUnauthorized", typ, err)
		}
	}

	// A provider that does not type its tokens, or spells Bearer differently, is fine.
	for _, typ := range []any{nil, "bearer", "Bearer"} {
		claims := claimSet(i.issuer(), clock.Now())
		if typ == nil {
			delete(claims, "typ")
		} else {
			claims["typ"] = typ
		}
		if _, err := v.VerifyToken(context.Background(), signRSA(t, signingKey(), rsaHeader(), claims)); err != nil {
			t.Errorf("typ %v: %v", typ, err)
		}
	}
}
