package hub_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// Reauthorize applies a revoke before it returns: nothing published after it
// reaches the client, without waiting for the acl event.
func TestReauthorizeRevokesBeforeReturning(t *testing.T) {
	h, b := newHub(t)
	allowed := true
	resolve := func(context.Context) ([]string, error) {
		if allowed {
			return []string{bus.PosUserWildcard("peer")}, nil
		}
		return nil, nil
	}
	c, err := h.Connect(context.Background(), "viewer", resolve)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Disconnect(c)

	for round := 0; round < 20; round++ {
		allowed = false
		h.Reauthorize(context.Background(), "viewer")
		_ = b.Publish(bus.PosSubject("peer", "phone"), []byte(`{"after":"revoke"}`))
		for {
			select {
			case raw := <-c.Out():
				var f hub.Frame
				_ = json.Unmarshal(raw, &f)
				if f.Type == hub.FramePosition {
					t.Fatalf("round %d: a fix published after Reauthorize was delivered", round)
				}
				continue
			case <-time.After(20 * time.Millisecond):
			}
			break
		}
		allowed = true
		h.Reauthorize(context.Background(), "viewer")
		_ = b.Publish(bus.PosSubject("peer", "phone"), []byte(`{"after":"grant"}`))
		readFrame(t, c, hub.FramePosition, time.Second)
	}
}
