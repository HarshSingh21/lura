package connect_test

import (
	"context"
	"errors"
	"testing"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// Two people inviting each other in the same instant must end up connected,
// once, on both sides — not with two crossed pending invitations neither can
// accept. Raced many times, because the bug is a window, not a path.
func TestCrossedInvitationsRacedAutoAccept(t *testing.T) {
	for round := 0; round < 50; round++ {
		svc, _ := newFixture(t)
		ctx := context.Background()
		errs := make(chan error, 2)
		start := make(chan struct{})
		for _, inv := range [][2]string{{alice, "bob@lura.local"}, {bob, "alice@lura.local"}} {
			go func(from, to string) {
				<-start
				_, err := svc.Invite(ctx, from, to)
				errs <- err
			}(inv[0], inv[1])
		}
		close(start)
		for i := 0; i < 2; i++ {
			if err := <-errs; err != nil {
				t.Fatalf("round %d: Invite: %v", round, err)
			}
		}
		for _, who := range []string{alice, bob} {
			peers, err := svc.List(ctx, who)
			if err != nil {
				t.Fatalf("List: %v", err)
			}
			if len(peers) != 1 || peers[0].Status != domain.ConnectionAccepted || !peers[0].SharingWithMe {
				t.Fatalf("round %d: %s has %+v, want one accepted, live connection", round, who, peers)
			}
		}
	}
}

// Inviting someone again is an answerable mistake (409), and must never
// downgrade a live connection back to a pending invitation.
func TestRepeatInviteIsAConflictAndChangesNothing(t *testing.T) {
	svc, _ := newFixture(t)
	ctx := context.Background()
	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); err != nil {
		t.Fatalf("Invite: %v", err)
	}
	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("second pending invite: err = %v, want ErrConflict", err)
	}
	if _, err := svc.Accept(ctx, bob, alice); err != nil {
		t.Fatalf("Accept: %v", err)
	}
	for _, inv := range [][2]string{{alice, "bob@lura.local"}, {bob, "alice@lura.local"}} {
		if _, err := svc.Invite(ctx, inv[0], inv[1]); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("%s re-inviting a connected peer: err = %v, want ErrConflict", inv[0], err)
		}
	}
	if !watches(subjects(t, svc, alice), bob) || !watches(subjects(t, svc, bob), alice) {
		t.Fatal("a repeat invite broke a live connection")
	}
}
