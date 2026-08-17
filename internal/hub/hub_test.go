package hub_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/hub"
)

func newHub(t *testing.T, opts ...hub.Option) (*hub.Hub, *bus.InProcess) {
	t.Helper()
	b := bus.NewInProcess(nil)
	h, err := hub.New(b, nil, opts...)
	if err != nil {
		t.Fatalf("hub.New: %v", err)
	}
	t.Cleanup(func() { h.Close(); _ = b.Close() })
	return h, b
}

// readFrame waits for one frame of the given type, ignoring others (the hello
// frame arrives first on every connection).
func readFrame(t *testing.T, c *hub.Client, want string, timeout time.Duration) hub.Frame {
	t.Helper()
	deadline := time.After(timeout)
	for {
		select {
		case raw, ok := <-c.Out():
			if !ok {
				t.Fatalf("outbox closed while waiting for a %q frame", want)
			}
			var f hub.Frame
			if err := json.Unmarshal(raw, &f); err != nil {
				t.Fatalf("undecodable frame: %v", err)
			}
			if f.Type == want {
				return f
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a %q frame", want)
		}
	}
}

func TestConnectSendsHelloAndSubscribes(t *testing.T) {
	h, b := newHub(t)

	client, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
		return []string{bus.PosUserWildcard("u1"), bus.GeoSubject("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(client)

	hello := readFrame(t, client, hub.FrameHello, time.Second)
	var payload struct {
		ClientID string   `json:"clientId"`
		ViewerID string   `json:"viewerId"`
		Subjects []string `json:"subjects"`
	}
	if err := json.Unmarshal(hello.Data, &payload); err != nil {
		t.Fatalf("hello payload: %v", err)
	}
	if payload.ViewerID != "u1" || len(payload.Subjects) != 2 {
		t.Errorf("hello = %+v", payload)
	}

	// A position on a subscribed subject arrives as a position frame.
	if err := b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"lat":1}`)); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	frame := readFrame(t, client, hub.FramePosition, time.Second)
	if frame.Subject != "pos.u1.d1" {
		t.Errorf("subject = %q", frame.Subject)
	}

	// A geo event arrives as a geo frame: the type is derived from the subject, so
	// the client can switch on it.
	if err := b.Publish(bus.GeoSubject("u1"), []byte(`{"trigger":"arrive"}`)); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	readFrame(t, client, hub.FrameGeo, time.Second)

	if h.Count() != 1 {
		t.Errorf("Count = %d, want 1", h.Count())
	}
}

// A viewer must never receive another user's positions.
func TestSubscriptionIsScopedToTheViewer(t *testing.T) {
	h, b := newHub(t)

	client, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
		return []string{bus.PosUserWildcard("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(client)
	readFrame(t, client, hub.FrameHello, time.Second)

	_ = b.Publish(bus.PosSubject("u2", "d9"), []byte(`{"lat":2}`)) // someone else
	_ = b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"lat":1}`)) // ours

	frame := readFrame(t, client, hub.FramePosition, time.Second)
	if frame.Subject != "pos.u1.d1" {
		t.Fatalf("received another user's subject: %q", frame.Subject)
	}
	// Nothing else should be queued.
	select {
	case raw := <-client.Out():
		t.Fatalf("unexpected extra frame: %s", raw)
	case <-time.After(150 * time.Millisecond):
	}
}

// Revoking a share publishes acl.<viewer>; the hub must re-run the resolver and
// drop the subscription immediately, never at the end of some TTL (HLD §5.1).
func TestACLRevokeDropsSubscriptionImmediately(t *testing.T) {
	h, b := newHub(t)

	var (
		mu      sync.Mutex
		granted = true
	)
	client, err := h.Connect(context.Background(), "share:tok", func(context.Context) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		if !granted {
			return nil, nil // revoked: grants nothing
		}
		return []string{bus.PosUserWildcard("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(client)
	readFrame(t, client, hub.FrameHello, time.Second)

	_ = b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"lat":1}`))
	readFrame(t, client, hub.FramePosition, time.Second)

	// Revoke.
	mu.Lock()
	granted = false
	mu.Unlock()
	if err := bus.PublishJSON(b, bus.ACLSubject("share:tok"), map[string]any{"action": "revoke"}); err != nil {
		t.Fatalf("publish acl: %v", err)
	}
	readFrame(t, client, hub.FrameACL, 2*time.Second)

	if subs := client.Subjects(); len(subs) != 0 {
		t.Fatalf("subscriptions survived the revoke: %v", subs)
	}

	// Positions published after the revoke must not reach this viewer.
	for i := 0; i < 5; i++ {
		_ = b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"lat":9}`))
	}
	select {
	case raw := <-client.Out():
		var f hub.Frame
		_ = json.Unmarshal(raw, &f)
		if f.Type == hub.FramePosition {
			t.Fatal("a revoked viewer still received a position")
		}
	case <-time.After(200 * time.Millisecond):
	}
}

// An ACL grant adds the subscription to a live connection without a reconnect.
func TestACLGrantAddsSubscription(t *testing.T) {
	h, b := newHub(t)

	var (
		mu      sync.Mutex
		granted = false
	)
	client, err := h.Connect(context.Background(), "u2", func(context.Context) ([]string, error) {
		mu.Lock()
		defer mu.Unlock()
		if !granted {
			return []string{bus.PosUserWildcard("u2")}, nil
		}
		return []string{bus.PosUserWildcard("u2"), bus.PosUserWildcard("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(client)
	readFrame(t, client, hub.FrameHello, time.Second)

	mu.Lock()
	granted = true
	mu.Unlock()
	_ = bus.PublishJSON(b, bus.ACLSubject("u2"), map[string]any{"action": "grant"})
	readFrame(t, client, hub.FrameACL, 2*time.Second)

	_ = b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"lat":1}`))
	frame := readFrame(t, client, hub.FramePosition, time.Second)
	if frame.Subject != "pos.u1.d1" {
		t.Errorf("subject = %q, want the newly granted one", frame.Subject)
	}
}

// The live map only needs the newest fix, so a client that stops reading must
// lose intermediate positions rather than grow an unbounded queue (HLD §5.1).
func TestDropToLatestForPositions(t *testing.T) {
	h, b := newHub(t, hub.WithOutboxSize(4))

	client, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
		return []string{bus.PosUserWildcard("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	defer h.Disconnect(client)

	// Deliberately do not read: fill the outbox well past its capacity.
	for i := 0; i < 200; i++ {
		if err := b.Publish(bus.PosSubject("u1", "d1"), []byte(`{"n":`+itoa(i)+`}`)); err != nil {
			t.Fatalf("Publish: %v", err)
		}
	}
	// Give the subscriber goroutine time to enqueue.
	time.Sleep(200 * time.Millisecond)

	if got := len(client.Out()); got > 4 {
		t.Fatalf("outbox holds %d frames, want at most 4: the buffer is unbounded", got)
	}

	// What is left must be recent, not the first four frames.
	var last hub.Frame
	for len(client.Out()) > 0 {
		raw := <-client.Out()
		_ = json.Unmarshal(raw, &last)
	}
	if last.Type == hub.FramePosition {
		var payload struct {
			N int `json:"n"`
		}
		if err := json.Unmarshal(last.Data, &payload); err == nil && payload.N < 100 {
			t.Errorf("newest retained frame is n=%d: old frames were kept over new ones", payload.N)
		}
	}
}

func TestDisconnectUnsubscribesAndClosesOutbox(t *testing.T) {
	h, b := newHub(t)

	client, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
		return []string{bus.PosUserWildcard("u1")}, nil
	})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	readFrame(t, client, hub.FrameHello, time.Second)

	h.Disconnect(client)
	if h.Count() != 0 {
		t.Errorf("Count = %d after disconnect, want 0", h.Count())
	}
	if subs := client.Subjects(); len(subs) != 0 {
		t.Errorf("subscriptions survived disconnect: %v", subs)
	}
	select {
	case <-client.Done():
	case <-time.After(time.Second):
		t.Error("Done was not closed")
	}

	// Publishing after a disconnect must not panic or block.
	if err := b.Publish(bus.PosSubject("u1", "d1"), []byte(`{}`)); err != nil {
		t.Errorf("Publish after disconnect: %v", err)
	}

	// Disconnecting twice is a no-op, not a double close.
	h.Disconnect(client)
}

// A resolver that fails must fail the connection rather than yield a socket with
// no authorization checks.
func TestConnectFailsWhenResolverFails(t *testing.T) {
	h, _ := newHub(t)
	_, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
		return nil, context.DeadlineExceeded
	})
	if err == nil {
		t.Fatal("Connect succeeded despite a failing resolver")
	}
	if h.Count() != 0 {
		t.Errorf("a failed connection was left registered: Count = %d", h.Count())
	}
}

func TestCloseDisconnectsEveryone(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()
	h, err := hub.New(b, nil)
	if err != nil {
		t.Fatalf("hub.New: %v", err)
	}

	for i := 0; i < 3; i++ {
		if _, err := h.Connect(context.Background(), "u1", func(context.Context) ([]string, error) {
			return []string{bus.PosUserWildcard("u1")}, nil
		}); err != nil {
			t.Fatalf("Connect: %v", err)
		}
	}
	if h.Count() != 3 {
		t.Fatalf("Count = %d, want 3", h.Count())
	}
	h.Close()
	if h.Count() != 0 {
		t.Errorf("Count = %d after Close, want 0", h.Count())
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := ""
	for n > 0 {
		digits = string(rune('0'+n%10)) + digits
		n /= 10
	}
	return digits
}
