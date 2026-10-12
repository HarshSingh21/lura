package connect_test

import (
	"context"
	"testing"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Every relationship change lands in both people's activity history, from
// each one's own side, and in nobody else's.
func TestConnectionChangesAreRecordedForBothSides(t *testing.T) {
	svc, st := newFixture(t)
	ctx := context.Background()

	mustConnect(t, svc, alice, "bob@lura.local", bob)
	if _, err := svc.SetSharing(ctx, alice, bob, false); err != nil {
		t.Fatal(err)
	}
	// Setting the same value again is not a change.
	if _, err := svc.SetSharing(ctx, alice, bob, false); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetSharing(ctx, alice, bob, true); err != nil {
		t.Fatal(err)
	}
	if err := svc.Remove(ctx, bob, alice); err != nil {
		t.Fatal(err)
	}

	want := []struct {
		action domain.ConnectionAction
		actor  string
	}{
		{domain.ConnectionActionRemoved, bob},
		{domain.ConnectionActionResumed, alice},
		{domain.ConnectionActionPaused, alice},
		{domain.ConnectionActionAccepted, bob},
		{domain.ConnectionActionInvited, alice},
	}
	for _, who := range []struct{ user, peer string }{{alice, bob}, {bob, alice}} {
		got, err := st.ListConnectionEvents(ctx, who.user, store.RangeQuery{})
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("%s has %d events, want %d: %+v", who.user, len(got), len(want), got)
		}
		// Events recorded in the same instant keep insertion order newest
		// first only by sort stability, so compare as a set of (action, actor).
		seen := map[domain.ConnectionAction]string{}
		for _, e := range got {
			if e.PeerID != who.peer || e.PeerName == "" {
				t.Errorf("%s event about %q (%q), want %s", who.user, e.PeerID, e.PeerName, who.peer)
			}
			seen[e.Action] = e.ActorID
		}
		for _, w := range want {
			if seen[w.action] != w.actor {
				t.Errorf("%s: %s by %q, want %q", who.user, w.action, seen[w.action], w.actor)
			}
		}
	}
	if got, _ := st.ListConnectionEvents(ctx, carol, store.RangeQuery{}); len(got) != 0 {
		t.Errorf("carol sees %d events of a relationship she is not in", len(got))
	}
}
