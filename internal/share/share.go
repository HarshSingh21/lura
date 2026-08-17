// Package share issues expiring, revocable, read-only live views.
//
// HLD §5.8 and §11 make the product rules explicit, and they are what shape this
// code:
//
//   - No account needed to view. A share is a token in a URL, resolved to a
//     read-only subscription — never to a session.
//   - Nothing covert. Every active share is listed to its owner, and the owner
//     always sees the "you are sharing" indicator, so there is no code path that
//     creates a share nobody can see.
//   - Revocation is immediate, not eventual. Revoke, expiry and the
//     "until I arrive" auto-revoke all publish acl.<viewer>, which makes the
//     Gateway drop that viewer's live subscriptions on the spot (HLD §5.1).
package share

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
	"go.opentelemetry.io/otel/attribute"
)

// ViewerPrefix namespaces a share viewer's ACL identity so it can never collide
// with a real user id.
const ViewerPrefix = "share:"

// ViewerID returns the ACL identity for a share token.
func ViewerID(token string) string { return ViewerPrefix + token }

// CreateRequest is the API-level input for a new share.
type CreateRequest struct {
	Label         string           `json:"label"`
	Mode          domain.ShareMode `json:"mode"`
	Duration      time.Duration    `json:"-"`
	DurationMins  int              `json:"durationMins"`
	ArrivePlaceID string           `json:"arrivePlaceId"`
	DeviceIDs     []string         `json:"deviceIds"`
}

// Service manages shares.
type Service struct {
	store   store.Store
	b       bus.Bus
	log     *slog.Logger
	baseURL string
	now     func() time.Time

	sub        bus.Subscription
	done       chan struct{}
	wg         sync.WaitGroup
	once       sync.Once
	sweepEvery time.Duration

	// users are the workspaces the expiry sweeper walks. Tracking them here
	// avoids scanning the users table every tick; Phase 2 replaces the sweeper
	// entirely with Valkey TTL keyspace notifications.
	usersMu sync.Mutex
	users   map[string]struct{}
}

// New returns an unstarted share service.
func New(st store.Store, b bus.Bus, log *slog.Logger, baseURL string) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{
		store:      st,
		b:          b,
		log:        log,
		baseURL:    strings.TrimRight(baseURL, "/"),
		now:        time.Now,
		done:       make(chan struct{}),
		sweepEvery: 15 * time.Second,
	}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

// Start subscribes to geo events (for "until I arrive") and starts the expiry
// sweeper.
func (s *Service) Start(ctx context.Context) error {
	sub, err := s.b.SubscribePartitioned(bus.GeoAll(), 1, bus.UserKey, func(m bus.Msg) {
		var ev domain.GeoEvent
		if err := json.Unmarshal(m.Data, &ev); err != nil {
			return
		}
		if ev.Trigger != domain.TriggerArrive {
			return
		}
		s.onArrive(context.WithoutCancel(ctx), ev)
	})
	if err != nil {
		return err
	}
	s.sub = sub

	s.wg.Add(1)
	go s.sweepLoop(context.WithoutCancel(ctx))
	return nil
}

// Stop stops the service.
func (s *Service) Stop() {
	s.once.Do(func() {
		if s.sub != nil {
			s.sub.Unsubscribe()
		}
		close(s.done)
	})
	s.wg.Wait()
}

// Create issues a share and returns it with its public link.
func (s *Service) Create(ctx context.Context, userID string, req CreateRequest) (domain.Share, string, error) {
	ctx, span := obs.Start(ctx, "share.create")
	defer span.End()

	if req.Mode == "" {
		req.Mode = domain.ShareUntilRevoke
	}

	sh := domain.Share{
		ID:        idgen.New("shr"),
		UserID:    userID,
		Token:     idgen.ShortToken(),
		Label:     strings.TrimSpace(req.Label),
		Mode:      req.Mode,
		DeviceIDs: req.DeviceIDs,
		CreatedAt: s.now().UTC(),
	}
	if sh.Label == "" {
		sh.Label = "Shared link"
	}

	switch req.Mode {
	case domain.ShareDuration:
		d := req.Duration
		if d <= 0 && req.DurationMins > 0 {
			d = time.Duration(req.DurationMins) * time.Minute
		}
		if d <= 0 {
			return domain.Share{}, "", fmt.Errorf("share: duration required for mode %q: %w", req.Mode, domain.ErrInvalid)
		}
		if d > 30*24*time.Hour {
			// A month-long "temporary" link is a permanent one with extra steps.
			return domain.Share{}, "", fmt.Errorf("share: duration exceeds 30 days: %w", domain.ErrInvalid)
		}
		exp := sh.CreatedAt.Add(d)
		sh.ExpiresAt = &exp

	case domain.ShareUntilArrive:
		if req.ArrivePlaceID == "" {
			return domain.Share{}, "", fmt.Errorf("share: arrivePlaceId required for mode %q: %w", req.Mode, domain.ErrInvalid)
		}
		if _, err := s.store.GetPlace(ctx, userID, req.ArrivePlaceID); err != nil {
			return domain.Share{}, "", fmt.Errorf("share: arrive place: %w", err)
		}
		sh.ArrivePlace = req.ArrivePlaceID
		// A safety net: "until I arrive" with a trip that never completes should
		// not share forever.
		exp := sh.CreatedAt.Add(24 * time.Hour)
		sh.ExpiresAt = &exp

	case domain.ShareUntilRevoke:
		// No expiry by design; the owner holds the off switch and can always see
		// the share in their list.

	default:
		return domain.Share{}, "", fmt.Errorf("share: unknown mode %q: %w", req.Mode, domain.ErrInvalid)
	}

	// Validate the device subset belongs to the sharer, so a crafted request
	// cannot share someone else's device.
	for _, id := range sh.DeviceIDs {
		if _, err := s.store.GetDevice(ctx, userID, id); err != nil {
			return domain.Share{}, "", fmt.Errorf("share: device %s: %w", id, err)
		}
	}

	created, err := s.store.CreateShare(ctx, sh)
	if err != nil {
		return domain.Share{}, "", err
	}

	s.publishACL(created, "grant", "")
	s.log.InfoContext(ctx, "share created",
		"share", created.ID, "mode", created.Mode, "label", created.Label, "expiresAt", created.ExpiresAt)
	span.SetAttributes(attribute.String("lura.share_id", created.ID))
	return created, s.Link(created), nil
}

// Link renders the URL a person is meant to open.
//
// This is the *web viewer* route, not the JSON endpoint. `/s/<token>` returns the
// raw snapshot for a client to consume; a human who pastes that into a browser
// gets a wall of JSON. The link that gets copied, texted and clicked must be the
// page: /share/<token>.
func (s *Service) Link(sh domain.Share) string {
	if s.baseURL == "" {
		return ViewerPath(sh.Token)
	}
	return s.baseURL + ViewerPath(sh.Token)
}

// ViewerPath is the client-side route that renders a share for a human.
func ViewerPath(token string) string { return "/share/" + token }

// APIPath is the JSON endpoint the viewer reads from.
func APIPath(token string) string { return "/s/" + token }

// Revoke turns a share off immediately.
func (s *Service) Revoke(ctx context.Context, userID, id, reason string) (domain.Share, error) {
	if reason == "" {
		reason = "revoked by owner"
	}
	sh, err := s.store.RevokeShare(ctx, userID, id, reason, s.now())
	if err != nil {
		return domain.Share{}, err
	}
	s.publishACL(sh, "revoke", reason)
	s.log.InfoContext(ctx, "share revoked", "share", sh.ID, "reason", reason)
	return sh, nil
}

// Resolve validates a token and returns the live share.
func (s *Service) Resolve(ctx context.Context, token string) (domain.Share, error) {
	sh, err := s.store.ShareByToken(ctx, token)
	if err != nil {
		return domain.Share{}, err
	}
	if !sh.Active(s.now()) {
		return domain.Share{}, fmt.Errorf("share expired or revoked: %w", domain.ErrForbidden)
	}
	return sh, nil
}

// Subjects returns the bus subjects a share grants. It is the authorization
// function the Gateway calls on connect and on every ACL change — which is why
// it re-resolves the token rather than trusting a captured share value.
func (s *Service) Subjects(ctx context.Context, token string) ([]string, error) {
	sh, err := s.Resolve(ctx, token)
	if err != nil {
		// Not an error for the caller: an expired share simply grants nothing,
		// and the Gateway drops the subscriptions it had.
		return nil, nil
	}
	if len(sh.DeviceIDs) == 0 {
		return []string{bus.PosUserWildcard(sh.UserID)}, nil
	}
	subjects := make([]string, 0, len(sh.DeviceIDs))
	for _, dev := range sh.DeviceIDs {
		subjects = append(subjects, bus.PosSubject(sh.UserID, dev))
	}
	return subjects, nil
}

// PublicView is what a recipient sees: the sharer's display name, the shared
// devices' latest positions, and how the share ends. No notes, no history, no
// places — a share is a live dot, not an account.
type PublicView struct {
	Label       string           `json:"label"`
	SharerName  string           `json:"sharerName"`
	Mode        domain.ShareMode `json:"mode"`
	ExpiresAt   *time.Time       `json:"expiresAt,omitempty"`
	ArrivePlace string           `json:"arrivePlaceName,omitempty"`
	Devices     []PublicDevice   `json:"devices"`
	ServerTime  time.Time        `json:"serverTime"`
}

// PublicDevice is one dot on a recipient's map.
type PublicDevice struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Point    *domain.Point `json:"point,omitempty"`
	SpeedMPS *float64      `json:"speedMps,omitempty"`
	LastSeen *time.Time    `json:"lastSeen,omitempty"`
}

// View builds the public snapshot for a token.
func (s *Service) View(ctx context.Context, token string) (PublicView, error) {
	sh, err := s.Resolve(ctx, token)
	if err != nil {
		return PublicView{}, err
	}

	user, err := s.store.GetUser(ctx, sh.UserID)
	if err != nil {
		return PublicView{}, err
	}
	name := user.DisplayName
	if name == "" {
		name = "Someone"
	}

	devices, err := s.store.ListDevices(ctx, sh.UserID)
	if err != nil {
		return PublicView{}, err
	}
	allowed := map[string]bool{}
	for _, id := range sh.DeviceIDs {
		allowed[id] = true
	}

	view := PublicView{
		Label:      sh.Label,
		SharerName: name,
		Mode:       sh.Mode,
		ExpiresAt:  sh.ExpiresAt,
		ServerTime: s.now().UTC(),
	}
	if sh.ArrivePlace != "" {
		if place, err := s.store.GetPlace(ctx, sh.UserID, sh.ArrivePlace); err == nil {
			view.ArrivePlace = place.Name
		}
	}
	for _, d := range devices {
		if len(allowed) > 0 && !allowed[d.ID] {
			continue
		}
		view.Devices = append(view.Devices, PublicDevice{
			ID: d.ID, Name: d.Name, Point: d.LastPoint, SpeedMPS: d.SpeedMPS, LastSeen: d.LastSeen,
		})
	}
	return view, nil
}

// onArrive auto-revokes "until I arrive" shares for the place just reached.
func (s *Service) onArrive(ctx context.Context, ev domain.GeoEvent) {
	shares, err := s.store.SharesForArrivePlace(ctx, ev.UserID, ev.PlaceID)
	if err != nil {
		s.log.ErrorContext(ctx, "share: lookup until-arrive shares failed", "error", err)
		return
	}
	for _, sh := range shares {
		if _, err := s.Revoke(ctx, sh.UserID, sh.ID, "arrived at "+ev.PlaceName); err != nil {
			s.log.ErrorContext(ctx, "share: auto-revoke failed", "share", sh.ID, "error", err)
		}
	}
}

// sweepLoop revokes shares whose expiry has passed. Expiry is also enforced on
// every read, so this loop is not what makes expiry correct — it is what makes
// it *timely* for viewers who are already connected.
func (s *Service) sweepLoop(ctx context.Context) {
	defer s.wg.Done()
	ticker := time.NewTicker(s.sweepEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			s.sweepExpired(ctx)
		case <-s.done:
			return
		}
	}
}

func (s *Service) sweepExpired(ctx context.Context) {
	// Listing per user would need a user index; Phase 1 has one workspace, and
	// Phase 2 replaces this with a "shares expiring soon" query plus a Valkey TTL
	// keyspace notification.
	users, err := s.activeUsers(ctx)
	if err != nil {
		return
	}
	now := s.now()
	for _, userID := range users {
		shares, err := s.store.ListShares(ctx, userID, true)
		if err != nil {
			continue
		}
		for _, sh := range shares {
			if sh.RevokedAt != nil || sh.ExpiresAt == nil || now.Before(*sh.ExpiresAt) {
				continue
			}
			if _, err := s.Revoke(ctx, userID, sh.ID, "expired"); err != nil {
				s.log.WarnContext(ctx, "share: expire failed", "share", sh.ID, "error", err)
			}
		}
	}
}

// activeUsers is the set of users the sweeper should consider. Phase 1 tracks it
// from share creation rather than scanning the users table.
func (s *Service) activeUsers(ctx context.Context) ([]string, error) {
	s.usersMu.Lock()
	defer s.usersMu.Unlock()
	out := make([]string, 0, len(s.users))
	for id := range s.users {
		out = append(out, id)
	}
	return out, nil
}

// Track registers a user with the sweeper (called on boot for the seeded user
// and whenever a share is created).
func (s *Service) Track(userID string) {
	if userID == "" {
		return
	}
	s.usersMu.Lock()
	if s.users == nil {
		s.users = map[string]struct{}{}
	}
	s.users[userID] = struct{}{}
	s.usersMu.Unlock()
}

func (s *Service) publishACL(sh domain.Share, action, reason string) {
	s.Track(sh.UserID)
	payload := map[string]any{
		"action":  action,
		"shareId": sh.ID,
		"mode":    sh.Mode,
		"label":   sh.Label,
		"reason":  reason,
	}
	// The viewer of the link: drops or gains their subscription.
	if err := bus.PublishJSON(s.b, bus.ACLSubject(ViewerID(sh.Token)), payload); err != nil {
		s.log.Warn("share: publish viewer acl failed", "error", err)
	}
	// The owner: their UI updates the "you are sharing" banner.
	if err := bus.PublishJSON(s.b, bus.ACLSubject(sh.UserID), payload); err != nil {
		s.log.Warn("share: publish owner acl failed", "error", err)
	}
}
