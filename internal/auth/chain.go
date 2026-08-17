package auth

import (
	"fmt"
	"net/http"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// Chain tries several authenticators in order and takes the first that accepts.
//
// It exists for exactly one situation: a deployment that has moved to real OIDC
// sessions but still wants the static development token to work — for the
// simulator, for curl, for a smoke test. That is a real convenience and a real
// risk, so it is opt-in (LURA_DEV_TOKEN_WITH_OIDC) and the server says so loudly
// at boot rather than quietly accepting a shared password forever.
//
// Order matters: put the strong authenticator first, so a valid session is never
// mistaken for the fallback.
type Chain struct {
	authenticators []Authenticator
}

// NewChain returns an authenticator that tries each in turn.
func NewChain(authenticators ...Authenticator) *Chain {
	return &Chain{authenticators: authenticators}
}

// Authenticate implements Authenticator.
func (c *Chain) Authenticate(r *http.Request) (Principal, error) {
	var lastErr error
	for _, a := range c.authenticators {
		principal, err := a.Authenticate(r)
		if err == nil {
			return principal, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no authenticator configured: %w", domain.ErrUnauthorized)
	}
	return Principal{}, lastErr
}

// VerifyRequest satisfies the claims-aware interface the API layer uses for
// account provisioning: it delegates to the first member that can produce
// claims and accepts this request. A request authenticated by a member without
// claims (the static token) provisions nothing, which is correct — there is no
// identity behind it to provision.
func (c *Chain) VerifyRequest(r *http.Request) (Principal, Claims, error) {
	var lastErr error
	for _, a := range c.authenticators {
		if withClaims, ok := a.(interface {
			VerifyRequest(*http.Request) (Principal, Claims, error)
		}); ok {
			principal, claims, err := withClaims.VerifyRequest(r)
			if err == nil {
				return principal, claims, nil
			}
			lastErr = err
			continue
		}
		principal, err := a.Authenticate(r)
		if err == nil {
			return principal, Claims{}, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no authenticator configured: %w", domain.ErrUnauthorized)
	}
	return Principal{}, Claims{}, lastErr
}

var _ Authenticator = (*Chain)(nil)
