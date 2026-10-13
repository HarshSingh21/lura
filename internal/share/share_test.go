package share_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/share"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

func newService(t *testing.T) (*share.Service, *bus.InProcess) {
	t.Helper()
	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	s := share.New(memory.New(), b, nil, "http://lura.test")
	if err := s.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(s.Stop)
	return s, b
}

// viewerFrames records what the viewer of a token is told on its ACL subject.
func viewerFrames(t *testing.T, b *bus.InProcess, token string) chan map[string]any {
	t.Helper()
	out := make(chan map[string]any, 8)
	sub, err := b.Subscribe(bus.ACLSubject(share.ViewerID(token)), func(m bus.Msg) {
		var v map[string]any
		if json.Unmarshal(m.Data, &v) == nil {
			out <- v
		}
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	t.Cleanup(sub.Unsubscribe)
	return out
}

// A link that runs out must end for a viewer who is still watching when it
// does, not up to a sweep (15 s) later: until the revoke, the hub keeps
// forwarding positions to them.
func TestExpiringShareEndsForItsViewerOnTime(t *testing.T) {
	s, b := newService(t)
	sh, _, err := s.Create(context.Background(), "u_harsh", share.CreateRequest{Label: "Priya", Mode: "duration", Duration: 300 * time.Millisecond})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	frames := viewerFrames(t, b, sh.Token)
	select {
	case f := <-frames:
		if f["action"] != "revoke" || f["reason"] != "expired" {
			t.Errorf("viewer frame = %v, want revoke/expired", f)
		}
		if _, ok := f["label"]; ok {
			t.Errorf("viewer frame carries the private label: %v", f)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the viewer was not told within 3 s that the link expired")
	}
	if _, err := s.Resolve(context.Background(), sh.Token); err == nil {
		t.Error("an expired link still resolves")
	}
}

// A link revoked by hand before it runs out is not revoked a second time.
func TestRevokedShareDoesNotExpireAgain(t *testing.T) {
	s, b := newService(t)
	ctx := context.Background()
	sh, _, err := s.Create(ctx, "u_harsh", share.CreateRequest{Mode: "duration", Duration: 300 * time.Millisecond})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	frames := viewerFrames(t, b, sh.Token)
	if _, err := s.Revoke(ctx, "u_harsh", sh.ID, ""); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	if f := <-frames; f["reason"] != "revoked by owner" {
		t.Errorf("first frame = %v", f)
	}
	select {
	case f := <-frames:
		t.Errorf("a revoked link was ended again: %v", f)
	case <-time.After(700 * time.Millisecond):
	}
}
