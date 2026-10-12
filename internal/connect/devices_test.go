package connect_test

import (
	"context"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// Deleting a phone must reach the maps of the people who can see its owner
// (and the owner's own other sessions) — but nobody else.
func TestDevicesChangedReachesWatchersOnly(t *testing.T) {
	ctx := context.Background()
	st := memory.New()
	for id, email := range map[string]string{alice: "alice@lura.local", bob: "bob@lura.local", carol: "carol@lura.local"} {
		if err := st.UpsertUser(ctx, domain.User{ID: id, Email: email, DisplayName: id, TZ: "UTC"}); err != nil {
			t.Fatal(err)
		}
	}
	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	svc := connect.New(st, b, nil)
	if _, err := svc.Invite(ctx, alice, "bob@lura.local"); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Accept(ctx, bob, alice); err != nil {
		t.Fatal(err)
	}

	got := make(chan string, 8)
	sub, err := b.Subscribe("acl.*", func(m bus.Msg) { got <- m.Subject })
	if err != nil {
		t.Fatal(err)
	}
	defer sub.Unsubscribe()

	svc.DevicesChanged(ctx, alice)
	seen := map[string]bool{}
	timeout := time.After(time.Second)
	for len(seen) < 2 {
		select {
		case s := <-got:
			seen[s] = true
		case <-timeout:
			t.Fatalf("acl subjects = %v, want alice's and bob's", seen)
		}
	}
	if !seen[bus.ACLSubject(alice)] || !seen[bus.ACLSubject(bob)] || seen[bus.ACLSubject(carol)] {
		t.Fatalf("acl subjects = %v", seen)
	}
}
