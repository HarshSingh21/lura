// Package auth authenticates requests.
//
// HLD §16 maps Phase 1 to a static bearer token and Phase 2 to Zitadel-issued
// JWTs. Both live behind the Authenticator interface, so swapping them is a
// wiring change in main and nothing else: handlers only ever see a Principal.
//
// Three principal kinds exist, and keeping them distinct is what stops a device
// credential from being usable as a control-plane credential:
//
//	user   — the control plane (places, notes, shares, history)
//	device — /pub only, scoped to one device
//	share  — a public share viewer: read-only, no account (HLD §5.8)
package auth

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Kind of principal.
type Kind string

const (
	KindUser   Kind = "user"
	KindDevice Kind = "device"
	KindShare  Kind = "share"
)

// Principal is who is making a request.
type Principal struct {
	Kind       Kind
	UserID     string
	DeviceID   string
	ShareToken string
}

// IsUser reports whether the principal may use the control plane.
func (p Principal) IsUser() bool { return p.Kind == KindUser && p.UserID != "" }

type ctxKey struct{}

// WithPrincipal stores a principal on the context.
func WithPrincipal(ctx context.Context, p Principal) context.Context {
	return context.WithValue(ctx, ctxKey{}, p)
}

// FromContext retrieves the principal, if any.
func FromContext(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(ctxKey{}).(Principal)
	return p, ok
}

// UserID returns the authenticated user id, or "".
func UserID(ctx context.Context) string {
	p, _ := FromContext(ctx)
	return p.UserID
}

// Authenticator resolves a request to a principal.
type Authenticator interface {
	Authenticate(r *http.Request) (Principal, error)
}

// StaticToken is the Phase 1 control-plane authenticator: one shared bearer
// token mapped to one workspace.
type StaticToken struct {
	Token  string
	UserID string
}

// NewStaticToken returns a static-token authenticator.
func NewStaticToken(token, userID string) *StaticToken {
	return &StaticToken{Token: token, UserID: userID}
}

// Authenticate implements Authenticator.
func (s *StaticToken) Authenticate(r *http.Request) (Principal, error) {
	tok := BearerToken(r)
	if tok == "" {
		return Principal{}, fmt.Errorf("missing bearer token: %w", domain.ErrUnauthorized)
	}
	// Constant-time compare: a token check that leaks timing is a token check
	// that can be brute-forced character by character.
	if subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) != 1 {
		return Principal{}, fmt.Errorf("invalid token: %w", domain.ErrUnauthorized)
	}
	return Principal{Kind: KindUser, UserID: s.UserID}, nil
}

// DeviceAuth authenticates /pub.
//
// It accepts three shapes, because "any existing OwnTracks install can point at
// Lura" (HLD §5.2) means meeting clients where they are:
//
//	Authorization: Bearer <device token>   — Lura's own clients
//	Authorization: Basic <user>:<token>    — OwnTracks HTTP mode
//	?device=<id> with the control-plane token — simulators and curl
type DeviceAuth struct {
	Devices  store.DeviceStore
	APIToken string
	UserID   string
}

// Authenticate implements Authenticator.
func (d *DeviceAuth) Authenticate(r *http.Request) (Principal, error) {
	ctx := r.Context()

	if tok := BearerToken(r); tok != "" {
		// The control-plane token may publish on behalf of a named device.
		if d.APIToken != "" && subtle.ConstantTimeCompare([]byte(tok), []byte(d.APIToken)) == 1 {
			id := r.URL.Query().Get("device")
			if id == "" {
				return Principal{}, fmt.Errorf("api token requires ?device=<id>: %w", domain.ErrUnauthorized)
			}
			dev, err := d.Devices.GetDevice(ctx, d.UserID, id)
			if err != nil {
				return Principal{}, fmt.Errorf("device %s: %w", id, domain.ErrUnauthorized)
			}
			return Principal{Kind: KindDevice, UserID: dev.UserID, DeviceID: dev.ID}, nil
		}
		dev, err := d.Devices.DeviceByToken(ctx, tok)
		if err != nil {
			return Principal{}, fmt.Errorf("device token: %w", domain.ErrUnauthorized)
		}
		return Principal{Kind: KindDevice, UserID: dev.UserID, DeviceID: dev.ID}, nil
	}

	if _, pass, ok := r.BasicAuth(); ok && pass != "" {
		dev, err := d.Devices.DeviceByToken(ctx, pass)
		if err != nil {
			return Principal{}, fmt.Errorf("device token: %w", domain.ErrUnauthorized)
		}
		return Principal{Kind: KindDevice, UserID: dev.UserID, DeviceID: dev.ID}, nil
	}

	// Query-string credentials: last resort for constrained trackers that cannot
	// set headers. Documented as such, and never accepted for the control plane.
	if tok := r.URL.Query().Get("token"); tok != "" {
		dev, err := d.Devices.DeviceByToken(ctx, tok)
		if err != nil {
			return Principal{}, fmt.Errorf("device token: %w", domain.ErrUnauthorized)
		}
		return Principal{Kind: KindDevice, UserID: dev.UserID, DeviceID: dev.ID}, nil
	}

	return Principal{}, fmt.Errorf("no device credentials: %w", domain.ErrUnauthorized)
}

// BearerToken extracts a bearer token from the Authorization header, falling
// back to the `access_token` query parameter — which browsers force on us for
// WebSocket connections, where custom headers are not available.
func BearerToken(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if h != "" {
		parts := strings.SplitN(h, " ", 2)
		if len(parts) == 2 && strings.EqualFold(parts[0], "bearer") {
			return strings.TrimSpace(parts[1])
		}
	}
	if v := r.URL.Query().Get("access_token"); v != "" {
		return v
	}
	if v := r.Header.Get("X-Lura-Token"); v != "" {
		return v
	}
	return ""
}

var (
	_ Authenticator = (*StaticToken)(nil)
	_ Authenticator = (*DeviceAuth)(nil)
)
