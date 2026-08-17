package connect_test

import (
	"context"
	"errors"
	"testing"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// These tests are about consent, not plumbing. The property that matters is:
// A may watch B only if *B* has accepted and *B's* sharing switch is on — never
// because of anything A did or set.

const (
	alice = "usr_alice"
	bob   = "usr_bob"
	carol = "usr_carol"
)

func newFixture(t *testing.T) (*connect.Service, *memory.Store) {
	t.Helper()
	ctx := context.Background()
	st := memory.New()
	for id, email := range map[string]string{
		alice: "alice@lura.local",
		bob:   "bob@lura.local",
		carol: "carol@lura.local",
	} {
		if err := st.UpsertUser(ctx, domain.User{ID: id, Email: email, DisplayName: id, TZ: "UTC"}); err != nil {
			t.Fatalf("seed user %s: %v", id, err)
		}
	}
	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	return connect.New(st, b, nil), st
}

func subjects(t *testing.T, svc *connect.Service, userID string) []string {
	t.Helper()
	subs, err := svc.Subjects(context.Background(), userID)
	if err != nil {
		t.Fatalf("Subjects(%s): %v", userID, err)
	}
	return subs
}

func watches(subs []string, peerID string) bool {
	want := bus.PosUserWildcard(peerID)
	for _, s := range subs {
		if s == want {
			return true
		}
	}
	return false
}

// An invitation alone grants nothing. Until the invitee accepts, neither side
// may watch the other — otherwise "invite" would be a way to start watching
// someone who never agreed.
func TestInvitationGrantsNothingUntilAccepted(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); err != nil {
		t.Fatalf("Invite: %v", err)
	}

	if watches(subjects(t, svc, alice), bob) {
		t.Error("the inviter can watch the invitee before they accepted")
	}
	if watches(subjects(t, svc, bob), alice) {
		t.Error("the invitee can watch the inviter before accepting")
	}

	// Both sides can see the pending row, which is what makes it actionable.
	forBob, err := svc.List(ctx, bob)
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(forBob) != 1 || forBob[0].Status != domain.ConnectionPendingIn {
		t.Fatalf("bob's list = %+v, want one pending_in", forBob)
	}
	if forBob[0].SharingWithMe {
		t.Error("a pending invitation reports the peer as sharing")
	}
}

// Accepting is what makes it two-way, and it is symmetric: both can now watch.
func TestAcceptingMakesItMutual(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if _, err := svc.Accept(ctx, bob, alice); err != nil {
		t.Fatalf("Accept: %v", err)
	}

	if !watches(subjects(t, svc, alice), bob) {
		t.Error("alice cannot watch bob after he accepted")
	}
	if !watches(subjects(t, svc, bob), alice) {
		t.Error("bob cannot watch alice after accepting")
	}

	// Everyone still sees their own subjects.
	for _, u := range []string{alice, bob} {
		if !watches(subjects(t, svc, u), u) {
			t.Errorf("%s lost their own position subscription", u)
		}
	}

	// Accepting twice is idempotent rather than an error.
	if _, err := svc.Accept(ctx, bob, alice); err != nil {
		t.Errorf("second Accept: %v", err)
	}
}

// The switch that stops the peer watching me is *mine*, and turning it off
// revokes their view — not mine of them.
func TestPausingSharingIsOneSided(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	mustConnect(t, svc, alice, "bob@lura.local", bob)

	if _, err := svc.SetSharing(ctx, alice, bob, false); err != nil {
		t.Fatalf("SetSharing: %v", err)
	}

	if watches(subjects(t, svc, bob), alice) {
		t.Error("bob still watches alice after she stopped sharing")
	}
	if !watches(subjects(t, svc, alice), bob) {
		t.Error("alice lost her view of bob by pausing her own sharing")
	}

	// And it comes back.
	if _, err := svc.SetSharing(ctx, alice, bob, true); err != nil {
		t.Fatalf("SetSharing(on): %v", err)
	}
	if !watches(subjects(t, svc, bob), alice) {
		t.Error("resuming sharing did not restore the peer's view")
	}
}

// A user cannot reach into the other side's row to grant themselves a view.
func TestCannotGrantYourselfAView(t *testing.T) {
	svc, st := newFixture(t)
	ctx := context.Background()

	mustConnect(t, svc, alice, "bob@lura.local", bob)
	if _, err := svc.SetSharing(ctx, bob, alice, false); err != nil {
		t.Fatalf("SetSharing: %v", err)
	}
	if watches(subjects(t, svc, alice), bob) {
		t.Fatal("precondition: alice should not be able to watch bob")
	}

	// Alice flips every switch she owns. Her own row cannot authorise her view of
	// bob, because the answer comes from bob's row.
	if _, err := svc.SetSharing(ctx, alice, bob, true); err != nil {
		t.Fatalf("SetSharing: %v", err)
	}
	if _, err := st.UpsertConnection(ctx, domain.Connection{
		UserID: alice, PeerID: bob, Status: domain.ConnectionAccepted, Sharing: true,
	}); err != nil {
		t.Fatalf("UpsertConnection: %v", err)
	}

	if watches(subjects(t, svc, alice), bob) {
		t.Error("a user granted themselves a view of a peer who is not sharing")
	}
}

// Removing a connection removes it for both people.
func TestRemoveIsSymmetric(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	mustConnect(t, svc, alice, "bob@lura.local", bob)
	if err := svc.Remove(ctx, alice, bob); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if watches(subjects(t, svc, alice), bob) || watches(subjects(t, svc, bob), alice) {
		t.Error("a removed connection still authorises a subscription")
	}
	for _, u := range []string{alice, bob} {
		list, err := svc.List(ctx, u)
		if err != nil {
			t.Fatalf("List(%s): %v", u, err)
		}
		if len(list) != 0 {
			t.Errorf("%s still lists the removed connection: %+v", u, list)
		}
	}
}

// Crossed invitations settle into one accepted connection rather than two
// pending ones that each wait for the other.
func TestCrossedInvitationsResolve(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); err != nil {
		t.Fatalf("Invite(alice→bob): %v", err)
	}
	if _, err := svc.Invite(ctx, bob, "alice@lura.local"); err != nil {
		t.Fatalf("Invite(bob→alice): %v", err)
	}

	if !watches(subjects(t, svc, alice), bob) || !watches(subjects(t, svc, bob), alice) {
		t.Error("crossed invitations did not resolve into a live connection")
	}
	if list, _ := svc.List(ctx, alice); len(list) != 1 {
		t.Errorf("alice has %d connections, want 1", len(list))
	}
}

// A third party is never included, whatever anyone else has agreed.
func TestUnrelatedUserSeesNothing(t *testing.T) {
	svc, _ := newFixture(t)
	mustConnect(t, svc, alice, "bob@lura.local", bob)

	subs := subjects(t, svc, carol)
	if watches(subs, alice) || watches(subs, bob) {
		t.Errorf("an unrelated user is subscribed to a connection they are not part of: %v", subs)
	}
	if len(subs) != 3 {
		t.Errorf("carol's subjects = %v, want only her own three", subs)
	}
}

func TestInviteValidation(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	if _, err := svc.Invite(ctx, alice, "   "); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("empty email = %v, want ErrInvalid", err)
	}
	if _, err := svc.Invite(ctx, alice, "alice@lura.local"); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("self-invite = %v, want ErrInvalid", err)
	}
	// An address with no account is a not-found, and the message must not confirm
	// or deny anything else about it.
	if _, err := svc.Invite(ctx, alice, "stranger@example.com"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("unknown email = %v, want ErrNotFound", err)
	}
	// Accepting something that was never offered is invalid, not a silent success.
	if _, err := svc.Accept(ctx, alice, carol); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("accept with no invitation = %v, want ErrNotFound", err)
	}
}

// Watchers backs the "who can see me" indicator, which HLD §11 requires to be
// always-on and accurate.
func TestWatchersReflectsRealAccess(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()

	mustConnect(t, svc, alice, "bob@lura.local", bob)

	watchers, err := svc.Watchers(ctx, alice)
	if err != nil {
		t.Fatalf("Watchers: %v", err)
	}
	if len(watchers) != 1 || watchers[0].PeerID != bob {
		t.Fatalf("watchers = %+v, want bob", watchers)
	}

	if _, err := svc.SetSharing(ctx, alice, bob, false); err != nil {
		t.Fatalf("SetSharing: %v", err)
	}
	watchers, _ = svc.Watchers(ctx, alice)
	if len(watchers) != 0 {
		t.Errorf("watchers = %+v after pausing, want none", watchers)
	}
}

// mustConnect drives an invitation through to an accepted connection.
func mustConnect(t *testing.T, svc *connect.Service, inviter, inviteeEmail, invitee string) {
	t.Helper()
	ctx := context.Background()
	if _, err := svc.Invite(ctx, inviter, inviteeEmail); err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if _, err := svc.Accept(ctx, invitee, inviter); err != nil {
		t.Fatalf("Accept: %v", err)
	}
}
