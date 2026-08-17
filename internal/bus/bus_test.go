package bus_test

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
)

func TestMatch(t *testing.T) {
	cases := []struct {
		pattern, subject string
		want             bool
	}{
		{"pos.u1.d1", "pos.u1.d1", true},
		{"pos.u1.*", "pos.u1.d1", true},
		{"pos.u1.*", "pos.u1.d1.extra", false},
		{"pos.*.d1", "pos.u1.d1", true},
		{"pos.>", "pos.u1.d1", true},
		{"pos.>", "pos.u1", true},
		{"pos.>", "pos", false}, // `>` must match at least one token
		{"geo.*", "geo.u1", true},
		{"geo.*", "geo", false},
		{"acl.*", "acl.share:abc", true},
		{"pos.u1.*", "pos.u2.d1", false},
		{"pos.u1.d1", "pos.u1.d2", false},
	}
	for _, tc := range cases {
		if got := bus.Match(tc.pattern, tc.subject); got != tc.want {
			t.Errorf("Match(%q, %q) = %v, want %v", tc.pattern, tc.subject, got, tc.want)
		}
	}
}

func TestSubjectBuilders(t *testing.T) {
	if got := bus.PosSubject("u1", "d1"); got != "pos.u1.d1" {
		t.Errorf("PosSubject = %q", got)
	}
	// The wildcard a Gateway subscribes to must match the subject ingest publishes.
	if !bus.Match(bus.PosUserWildcard("u1"), bus.PosSubject("u1", "d1")) {
		t.Error("PosUserWildcard does not match PosSubject")
	}
	if !bus.Match(bus.PosAll(), bus.PosSubject("u1", "d1")) {
		t.Error("PosAll does not match PosSubject")
	}
	if !bus.Match(bus.GeoAll(), bus.GeoSubject("u1")) {
		t.Error("GeoAll does not match GeoSubject")
	}
	if bus.Match(bus.PosUserWildcard("u1"), bus.PosSubject("u2", "d1")) {
		t.Error("a user's wildcard matched another user's subject")
	}
}

func TestCoreDeliversToMatchingSubscribers(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	var (
		mu   sync.Mutex
		got  []string
		done = make(chan struct{}, 3)
	)
	sub, err := b.Subscribe("pos.u1.*", func(m bus.Msg) {
		mu.Lock()
		got = append(got, string(m.Data))
		mu.Unlock()
		done <- struct{}{}
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	// Only the first two match the pattern.
	_ = b.Publish("pos.u1.d1", []byte("a"))
	_ = b.Publish("pos.u1.d2", []byte("b"))
	_ = b.Publish("pos.u2.d1", []byte("c"))

	for i := 0; i < 2; i++ {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for delivery")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("delivered %v, want two messages", got)
	}
}

// A slow core subscriber must lose messages rather than block the publisher: the
// live path is at-most-once by design (HLD §4).
func TestCoreDropsForSlowSubscriber(t *testing.T) {
	b := bus.NewInProcess(nil, bus.WithBuffers(2, 0))
	defer func() { _ = b.Close() }()

	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	sub, err := b.Subscribe("pos.>", func(bus.Msg) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release // wedge the subscriber
	})
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer func() { close(release); sub.Unsubscribe() }()

	_ = b.Publish("pos.u1.d1", []byte("first"))
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("subscriber never ran")
	}

	// Publishing far more than the buffer must still return promptly.
	start := time.Now()
	for i := 0; i < 200; i++ {
		if err := b.Publish("pos.u1.d1", []byte(fmt.Sprint(i))); err != nil {
			t.Fatalf("Publish: %v", err)
		}
	}
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Fatalf("publishing to a wedged subscriber took %s: the live path blocked", elapsed)
	}
	if bus.DroppedFor(sub) == 0 {
		t.Error("no drops recorded for a wedged subscriber")
	}
}

// The durable path is the ordering guarantee the geofence engine depends on: all
// messages for one partition key are handled by one goroutine, in publish order
// (HLD §5.4, per-device partitioning).
func TestPartitionedOrderingPerKey(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	const (
		devices = 4
		perDev  = 50
	)

	var (
		mu      sync.Mutex
		seen    = map[string][]int{}
		wg      sync.WaitGroup
		threads = map[string]map[string]bool{}
	)
	wg.Add(devices * perDev)

	sub, err := b.SubscribePartitioned(bus.PosAll(), 3, bus.DeviceKey, func(m bus.Msg) {
		defer wg.Done()
		dev := bus.DeviceKey(m)
		var n int
		_, _ = fmt.Sscanf(string(m.Data), "%d", &n)

		mu.Lock()
		seen[dev] = append(seen[dev], n)
		if threads[dev] == nil {
			threads[dev] = map[string]bool{}
		}
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("SubscribePartitioned: %v", err)
	}
	defer sub.Unsubscribe()

	for d := 0; d < devices; d++ {
		for i := 0; i < perDev; i++ {
			if err := b.PublishDurable(fmt.Sprintf("pos.u1.dev%d", d), []byte(fmt.Sprint(i))); err != nil {
				t.Fatalf("PublishDurable: %v", err)
			}
		}
	}

	waitWG(t, &wg, 5*time.Second)

	mu.Lock()
	defer mu.Unlock()
	for dev, order := range seen {
		if len(order) != perDev {
			t.Errorf("%s got %d messages, want %d", dev, len(order), perDev)
			continue
		}
		for i, n := range order {
			if n != i {
				t.Fatalf("%s out of order at index %d: %v", dev, i, order[:min(i+3, len(order))])
			}
		}
	}
}

// Durable messages must not be lost when the subscription is torn down: an
// orderly shutdown drains what it already accepted.
func TestPartitionedDrainsOnUnsubscribe(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	var (
		mu    sync.Mutex
		count int
	)
	sub, err := b.SubscribePartitioned(bus.GeoAll(), 1, bus.UserKey, func(bus.Msg) {
		mu.Lock()
		count++
		mu.Unlock()
	})
	if err != nil {
		t.Fatalf("SubscribePartitioned: %v", err)
	}

	const n = 100
	for i := 0; i < n; i++ {
		if err := b.PublishDurable("geo.u1", []byte("x")); err != nil {
			t.Fatalf("PublishDurable: %v", err)
		}
	}
	sub.Unsubscribe() // blocks until the workers have drained

	mu.Lock()
	defer mu.Unlock()
	if count != n {
		t.Errorf("handled %d of %d durable messages after unsubscribe", count, n)
	}
}

func TestPublishAfterCloseFails(t *testing.T) {
	b := bus.NewInProcess(nil)
	if err := b.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if err := b.Publish("pos.u1.d1", nil); err == nil {
		t.Error("Publish after Close succeeded")
	}
	if err := b.PublishDurable("pos.u1.d1", nil); err == nil {
		t.Error("PublishDurable after Close succeeded")
	}
}

// A panicking handler must not take the process down with it.
func TestHandlerPanicIsContained(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	ok := make(chan struct{}, 1)
	bad, err := b.Subscribe("geo.*", func(bus.Msg) { panic("boom") })
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer bad.Unsubscribe()
	good, err := b.Subscribe("geo.*", func(bus.Msg) { ok <- struct{}{} })
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer good.Unsubscribe()

	_ = b.Publish("geo.u1", []byte("x"))
	select {
	case <-ok:
	case <-time.After(time.Second):
		t.Fatal("a panicking subscriber prevented delivery to the others")
	}
}

func TestPublishJSONRoundTrip(t *testing.T) {
	b := bus.NewInProcess(nil)
	defer func() { _ = b.Close() }()

	type payload struct {
		Lat float64 `json:"lat"`
	}
	got := make(chan string, 1)
	sub, err := b.Subscribe("pos.>", func(m bus.Msg) { got <- string(m.Data) })
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer sub.Unsubscribe()

	if err := bus.PublishJSON(b, "pos.u1.d1", payload{Lat: 12.5}); err != nil {
		t.Fatalf("PublishJSON: %v", err)
	}
	select {
	case body := <-got:
		if body != `{"lat":12.5}` {
			t.Errorf("payload = %s", body)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out")
	}
}

func waitWG(t *testing.T, wg *sync.WaitGroup, d time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatal("timed out waiting for handlers")
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
