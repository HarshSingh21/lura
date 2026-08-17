package httpapi

import (
	"context"
	"net/http"
	"sync"

	"github.com/HarshSingh21/locnot/internal/auth"
	"github.com/HarshSingh21/locnot/internal/domain"
)

// claimsAuthenticator is implemented by authenticators that can hand back the
// identity claims alongside the principal (the OIDC verifier does; the static
// token does not, because there is nothing to provision from).
type claimsAuthenticator interface {
	VerifyRequest(r *http.Request) (auth.Principal, auth.Claims, error)
}

// provisioner turns a verified identity into a Lura account.
//
// With an external IdP, a person exists before their workspace does: the first
// request after signing in carries a `sub` that has no row here yet. Creating it
// lazily on that request — rather than requiring a registration webhook from
// Keycloak — means the two systems cannot drift out of step, and a realm restored
// from backup or a user created directly in the admin console still works.
//
// The claims are the source of truth for identity (email, display name); Lura
// owns everything else about the row (timezone, quiet hours, airgap).
type provisioner struct {
	server *Server

	// known caches the user ids already provisioned, so the steady state costs a
	// map lookup rather than a database round trip per request.
	known sync.Map
}

func newProvisioner(s *Server) *provisioner { return &provisioner{server: s} }

// identify authenticates a request, returning claims when the authenticator can
// supply them. It is the one place that knows about the claims-aware interface.
func (s *Server) identify(r *http.Request) (auth.Principal, auth.Claims, error) {
	if verifier, ok := s.deps.Auth.(claimsAuthenticator); ok {
		return verifier.VerifyRequest(r)
	}
	principal, err := s.deps.Auth.Authenticate(r)
	return principal, auth.Claims{}, err
}

// ensure creates the account if this is the first time we have seen the subject.
func (p *provisioner) ensure(ctx context.Context, principal auth.Principal, claims auth.Claims) error {
	// No subject, or an identity with no claims behind it (the development
	// token): nothing to provision.
	if principal.UserID == "" || claims.Subject == "" {
		return nil
	}
	if _, seen := p.known.Load(principal.UserID); seen {
		return nil
	}

	if _, err := p.server.deps.Store.GetUser(ctx, principal.UserID); err == nil {
		p.known.Store(principal.UserID, struct{}{})
		return nil
	}

	user := domain.User{
		ID:          principal.UserID,
		Email:       claims.Email,
		DisplayName: displayNameFrom(claims),
		Locale:      "en",
		// A sensible default the person can change in Settings; quiet hours are
		// evaluated in it, so leaving it empty would silently mean UTC.
		TZ: p.server.deps.Config.DefaultTimezone(),
	}
	if err := p.server.deps.Store.UpsertUser(ctx, user); err != nil {
		return err
	}
	p.known.Store(principal.UserID, struct{}{})
	p.server.log.InfoContext(ctx, "provisioned account from identity provider",
		"user", user.ID, "email", user.Email, "name", user.DisplayName)
	return nil
}

// displayNameFrom picks the friendliest label the IdP gave us.
func displayNameFrom(c auth.Claims) string {
	switch {
	case c.Name != "":
		return c.Name
	case c.Username != "":
		return c.Username
	case c.Email != "":
		return c.Email
	default:
		return "Lura user"
	}
}
