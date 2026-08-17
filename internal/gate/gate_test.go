package gate_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/gate"
)

// The gate is the cool-off primitive: exactly one caller may act per window.
func TestAcquireIsExclusiveWithinTheWindow(t *testing.T) {
	ctx := context.Background()
	g := gate.NewMemory()

	ok, err := g.Acquire(ctx, "k", time.Minute)
	if err != nil || !ok {
		t.Fatalf("first Acquire = %v, %v; want true, nil", ok, err)
	}
	for i := 0; i < 5; i++ {
		if ok, err := g.Acquire(ctx, "k", time.Minute); err != nil || ok {
			t.Fatalf("Acquire inside the window = %v, %v; want false, nil", ok, err)
		}
	}
	// A different key is unaffected: cool-off is per (device, place, trigger).
	if ok, err := g.Acquire(ctx, "other", time.Minute); err != nil || !ok {
		t.Fatalf("Acquire(other) = %v, %v; want true, nil", ok, err)
	}
}

func TestClaimExpires(t *testing.T) {
	ctx := context.Background()
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	clock := &fakeClock{now: now}
	g := gate.NewMemory().WithClock(clock.Now)

	if ok, _ := g.Acquire(ctx, "k", time.Minute); !ok {
		t.Fatal("first Acquire failed")
	}
	clock.advance(59 * time.Second)
	if ok, _ := g.Acquire(ctx, "k", time.Minute); ok {
		t.Error("claim expired early")
	}
	clock.advance(2 * time.Second)
	if ok, _ := g.Acquire(ctx, "k", time.Minute); !ok {
		t.Error("claim did not expire after its TTL")
	}
}

func TestTTLReportsRemaining(t *testing.T) {
	ctx := context.Background()
	clock := &fakeClock{now: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)}
	g := gate.NewMemory().WithClock(clock.Now)

	if ttl, _ := g.TTL(ctx, "k"); ttl != 0 {
		t.Errorf("TTL of an unclaimed key = %v, want 0", ttl)
	}
	_, _ = g.Acquire(ctx, "k", time.Minute)
	clock.advance(20 * time.Second)
	ttl, err := g.TTL(ctx, "k")
	if err != nil {
		t.Fatalf("TTL: %v", err)
	}
	if ttl != 40*time.Second {
		t.Errorf("TTL = %v, want 40s", ttl)
	}
}

func TestReleaseAllowsImmediateReacquire(t *testing.T) {
	ctx := context.Background()
	g := gate.NewMemory()

	_, _ = g.Acquire(ctx, "k", time.Hour)
	if err := g.Release(ctx, "k"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if ok, _ := g.Acquire(ctx, "k", time.Hour); !ok {
		t.Error("Acquire after Release failed")
	}
}

// A zero TTL means "no cool-off configured", which must not silently suppress
// every event.
func TestZeroTTLAlwaysAllows(t *testing.T) {
	ctx := context.Background()
	g := gate.NewMemory()
	for i := 0; i < 3; i++ {
		if ok, err := g.Acquire(ctx, "k", 0); err != nil || !ok {
			t.Fatalf("Acquire with a zero TTL = %v, %v; want true, nil", ok, err)
		}
	}
}

// Under concurrency exactly one caller may win — this is the property that makes
// the gate a safe stand-in for Valkey's SET NX (HLD §5.4).
func TestOnlyOneWinnerUnderConcurrency(t *testing.T) {
	ctx := context.Background()
	g := gate.NewMemory()

	const racers = 64
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		winners int
		start   = make(chan struct{})
	)
	wg.Add(racers)
	for i := 0; i < racers; i++ {
		go func() {
			defer wg.Done()
			<-start
			if ok, err := g.Acquire(ctx, "same-key", time.Minute); err == nil && ok {
				mu.Lock()
				winners++
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()

	if winners != 1 {
		t.Fatalf("%d callers won the same claim, want exactly 1", winners)
	}
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}
