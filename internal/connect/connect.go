// Package connect implements mutual live-location sharing between accounts.
//
// HLD §2.1 calls for "multi-user accounts + mutual-consent group sharing", and
// §11 makes the consent rules product-defining: nothing covert, mutual consent
// between people, and an indicator the watched person cannot miss. This package
// is where those rules are enforced rather than merely displayed.
//
// The model is two rows, one per direction, each owned by its user:
//
//	A→B {status, sharing}    B→A {status, sharing}
//
// and the authorization question the Gateway asks — "may A watch B?" — is
// answered by *B's* row: B must have accepted, and B's own sharing switch must be
// on. A cannot answer that question on B's behalf, which is what makes the
// consent real rather than a UI convention.
//
// Every change publishes acl.<viewer> so the Gateway re-evaluates live
// subscriptions immediately (HLD §5.1). Pausing sharing therefore stops the next
// fix reaching the peer, not the fix after some cache expires.
package connect

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Service manages connections between accounts.
type Service struct {
	store store.Store
	b     bus.Bus
	log   *slog.Logger
	now   func() time.Time
}

// New returns a connections service.
func New(st store.Store, b bus.Bus, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{store: st, b: b, log: log, now: time.Now}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Peer is a connection rendered for the UI, with the peer's live devices when
// the peer is currently sharing with this user.
type Peer struct {
	domain.Connection

	// WatchingMe reports whether the peer may currently see this user — that is,
	// this user's own switch. Named from the watched person's point of view
	// because that is the question the indicator answers.
	WatchingMe bool `json:"watchingMe"`
	// SharingWithMe reports whether this user may currently see the peer.
	SharingWithMe bool `json:"sharingWithMe"`

	Devices []PeerDevice `json:"devices"`
}

// PeerDevice is one of a peer's devices, reduced to what a viewer may see: a
// name and a position. No battery, no history, no notes.
type PeerDevice struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Point    *domain.Point `json:"point,omitempty"`
	SpeedMPS *float64      `json:"speedMps,omitempty"`
	LastSeen *time.Time    `json:"lastSeen,omitempty"`
}

// List returns this user's connections, resolving live device positions for the
// peers who are currently sharing.
func (s *Service) List(ctx context.Context, userID string) ([]Peer, error) {
	conns, err := s.store.ListConnections(ctx, userID)
	if err != nil {
		return nil, err
	}

	out := make([]Peer, 0, len(conns))
	for _, c := range conns {
		peer := Peer{Connection: c, WatchingMe: c.Live()}

		// What the peer lets *me* see lives in the peer's own row.
		theirs, err := s.store.GetConnection(ctx, c.PeerID, userID)
		if err == nil && theirs.Live() {
			peer.SharingWithMe = true
			devices, err := s.store.ListDevices(ctx, c.PeerID)
			if err != nil {
				return nil, err
			}
			for _, d := range devices {
				if d.LastPoint == nil {
					continue // a device with no fix is noise on someone else's map
				}
				peer.Devices = append(peer.Devices, PeerDevice{
					ID: d.ID, Name: d.Name, Point: d.LastPoint, SpeedMPS: d.SpeedMPS, LastSeen: d.LastSeen,
				})
			}
		}
		out = append(out, peer)
	}
	return out, nil
}

// Invite creates (or re-sends) an invitation to the account with this email.
func (s *Service) Invite(ctx context.Context, userID, email string) (domain.Connection, error) {
	ctx, span := obs.Start(ctx, "connect.invite")
	defer span.End()

	email = strings.TrimSpace(email)
	if email == "" {
		return domain.Connection{}, fmt.Errorf("email is required: %w", domain.ErrInvalid)
	}

	me, err := s.store.GetUser(ctx, userID)
	if err != nil {
		return domain.Connection{}, err
	}
	peer, err := s.store.FindUserByEmail(ctx, email)
	if err != nil {
		// Deliberately the same error the caller would get for any missing row:
		// this endpoint must not become a way to test whether an address has an
		// account on this server.
		return domain.Connection{}, fmt.Errorf("no account for %s: %w", email, domain.ErrNotFound)
	}
	if peer.ID == userID {
		return domain.Connection{}, fmt.Errorf("cannot connect to yourself: %w", domain.ErrInvalid)
	}

	// If they already invited me, treat this as accepting rather than creating a
	// crossed pair of pending invitations.
	if existing, err := s.store.GetConnection(ctx, userID, peer.ID); err == nil &&
		existing.Status == domain.ConnectionPendingIn {
		return s.Accept(ctx, userID, peer.ID)
	}

	mine, err := s.store.UpsertConnection(ctx, domain.Connection{
		UserID: userID, PeerID: peer.ID,
		PeerName: displayName(peer), PeerEmail: peer.Email,
		Status: domain.ConnectionPendingOut, Sharing: true,
	})
	if err != nil {
		return domain.Connection{}, err
	}
	if _, err := s.store.UpsertConnection(ctx, domain.Connection{
		UserID: peer.ID, PeerID: userID,
		PeerName: displayName(me), PeerEmail: me.Email,
		Status: domain.ConnectionPendingIn,
		// Their switch defaults to on, but it only takes effect once they accept —
		// Live() requires both. Accepting is the consent; this is just the default
		// they can change afterwards.
		Sharing: true,
	}); err != nil {
		return domain.Connection{}, err
	}

	s.notify(userID, peer.ID, "invite")
	s.log.InfoContext(ctx, "connection invited", "from", userID, "to", peer.ID)
	return mine, nil
}

// Accept turns a received invitation into a live, two-way connection.
func (s *Service) Accept(ctx context.Context, userID, peerID string) (domain.Connection, error) {
	ctx, span := obs.Start(ctx, "connect.accept")
	defer span.End()

	mine, err := s.store.GetConnection(ctx, userID, peerID)
	if err != nil {
		return domain.Connection{}, err
	}
	if mine.Status == domain.ConnectionAccepted {
		return mine, nil // idempotent: accepting twice is not an error
	}
	if mine.Status != domain.ConnectionPendingIn {
		return domain.Connection{}, fmt.Errorf("nothing to accept from %s: %w", peerID, domain.ErrInvalid)
	}

	mine.Status = domain.ConnectionAccepted
	accepted, err := s.store.UpsertConnection(ctx, mine)
	if err != nil {
		return domain.Connection{}, err
	}

	theirs, err := s.store.GetConnection(ctx, peerID, userID)
	if err != nil {
		return domain.Connection{}, err
	}
	theirs.Status = domain.ConnectionAccepted
	if _, err := s.store.UpsertConnection(ctx, theirs); err != nil {
		return domain.Connection{}, err
	}

	s.notify(userID, peerID, "accept")
	s.log.InfoContext(ctx, "connection accepted", "user", userID, "peer", peerID)
	return accepted, nil
}

// SetSharing flips this user's own switch for one peer.
func (s *Service) SetSharing(ctx context.Context, userID, peerID string, sharing bool) (domain.Connection, error) {
	mine, err := s.store.GetConnection(ctx, userID, peerID)
	if err != nil {
		return domain.Connection{}, err
	}
	mine.Sharing = sharing
	updated, err := s.store.UpsertConnection(ctx, mine)
	if err != nil {
		return domain.Connection{}, err
	}

	// The peer's subscription has to change now, not on their next reconnect.
	s.notify(userID, peerID, "sharing")
	s.log.InfoContext(ctx, "connection sharing changed", "user", userID, "peer", peerID, "sharing", sharing)
	return updated, nil
}

// Remove deletes the relationship from both sides.
//
// Both rows go: leaving the peer's row behind would mean a connection that one
// person can still see in their list and that no longer works.
func (s *Service) Remove(ctx context.Context, userID, peerID string) error {
	if err := s.store.DeleteConnection(ctx, userID, peerID); err != nil {
		return err
	}
	if err := s.store.DeleteConnection(ctx, peerID, userID); err != nil && !isNotFound(err) {
		return err
	}
	s.notify(userID, peerID, "remove")
	s.log.InfoContext(ctx, "connection removed", "user", userID, "peer", peerID)
	return nil
}

// Subjects returns every bus subject this user is authorised to receive.
//
// This is the function the Gateway calls on connect and again on every ACL
// event, so it is the single place that decides who may watch whom. It answers
// from the *peer's* row, never the caller's.
func (s *Service) Subjects(ctx context.Context, userID string) ([]string, error) {
	subjects := []string{
		bus.PosUserWildcard(userID), // my own devices
		bus.GeoSubject(userID),      // my geofence events
		bus.NotifySubject(userID),   // my reminders
	}

	conns, err := s.store.ListConnections(ctx, userID)
	if err != nil {
		return nil, err
	}
	for _, c := range conns {
		if c.Status != domain.ConnectionAccepted {
			continue
		}
		theirs, err := s.store.GetConnection(ctx, c.PeerID, userID)
		if err != nil || !theirs.Live() {
			// No row, not accepted, or their switch is off: no subscription. A
			// missing row is a "no", never a default "yes".
			continue
		}
		subjects = append(subjects, bus.PosUserWildcard(c.PeerID))
	}
	return subjects, nil
}

// Watchers returns the users who may currently see this user's position — what
// the "who can see me" indicator is built from.
func (s *Service) Watchers(ctx context.Context, userID string) ([]domain.Connection, error) {
	conns, err := s.store.ListConnections(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := []domain.Connection{}
	for _, c := range conns {
		if c.Live() {
			out = append(out, c)
		}
	}
	return out, nil
}

// notify tells both sides to re-evaluate their subscriptions.
func (s *Service) notify(userID, peerID, action string) {
	payload := map[string]any{"action": action, "peerId": peerID, "userId": userID}
	for _, viewer := range []string{userID, peerID} {
		if err := bus.PublishJSON(s.b, bus.ACLSubject(viewer), payload); err != nil {
			s.log.Warn("connect: publish acl failed", "viewer", viewer, "error", err)
		}
	}
}

func displayName(u domain.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	if u.Email != "" {
		return u.Email
	}
	return u.ID
}

func isNotFound(err error) bool { return errors.Is(err, domain.ErrNotFound) }
