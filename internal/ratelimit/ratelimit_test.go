package ratelimit_test

import (
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/ratelimit"
)

func TestBurstThenRefill(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)}
	// 60/min = 1/s, burst 5.
	l := ratelimit.New(60, 5).WithClock(clock.Now)

	for i := 0; i < 5; i++ {
		if !l.Allow("d1") {
			t.Fatalf("burst request %d was refused", i+1)
		}
	}
	if l.Allow("d1") {
		t.Fatal("a sixth immediate request was allowed past the burst")
	}
	if retry := l.Retry("d1"); retry <= 0 || retry > time.Second+time.Millisecond {
		t.Errorf("Retry = %v, want ≈1s", retry)
	}

	clock.advance(time.Second)
	if !l.Allow("d1") {
		t.Error("a request was refused after a second of refill")
	}

	// Refill is capped at the burst size, not accumulated forever.
	clock.advance(time.Hour)
	allowed := 0
	for i := 0; i < 20; i++ {
		if l.Allow("d1") {
			allowed++
		}
	}
	if allowed != 5 {
		t.Errorf("after an hour idle, %d requests were allowed, want 5 (the burst cap)", allowed)
	}
}

// Budgets are per device: one runaway tracker must not silence the household.
func TestKeysAreIndependent(t *testing.T) {
	l := ratelimit.New(60, 2)

	for i := 0; i < 2; i++ {
		if !l.Allow("noisy") {
			t.Fatal("noisy device refused inside its burst")
		}
	}
	if l.Allow("noisy") {
		t.Fatal("noisy device exceeded its burst")
	}
	if !l.Allow("quiet") {
		t.Error("a second device was limited by the first")
	}
	if l.Len() != 2 {
		t.Errorf("tracked %d keys, want 2", l.Len())
	}
}

func TestRetryIsZeroWhenTokensRemain(t *testing.T) {
	l := ratelimit.New(60, 3)
	if retry := l.Retry("unknown"); retry != 0 {
		t.Errorf("Retry for an unseen key = %v, want 0", retry)
	}
	l.Allow("d1")
	if retry := l.Retry("d1"); retry != 0 {
		t.Errorf("Retry with tokens left = %v, want 0", retry)
	}
}

// Idle keys are evicted, so a long-lived process does not leak a map entry per
// device it has ever seen.
func TestIdleKeysAreEvicted(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)}
	l := ratelimit.New(600, 10).WithClock(clock.Now)

	for i := 0; i < 50; i++ {
		l.Allow(keyFor(i))
	}
	if l.Len() != 50 {
		t.Fatalf("tracked %d keys, want 50", l.Len())
	}

	// Well past the idle TTL, one more call triggers the sweep.
	clock.advance(2 * time.Hour)
	l.Allow("survivor")
	if l.Len() > 2 {
		t.Errorf("after the sweep %d keys remain, want at most 2", l.Len())
	}
}

func TestConcurrentAllowIsSafe(t *testing.T) {
	l := ratelimit.New(6000, 100)

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				l.Allow(keyFor(n % 4))
			}
		}(i)
	}
	wg.Wait() // the race detector is the assertion here
	if l.Len() != 4 {
		t.Errorf("tracked %d keys, want 4", l.Len())
	}
}

func keyFor(n int) string {
	return "device-" + string(rune('a'+n%26)) + string(rune('a'+(n/26)%26))
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
