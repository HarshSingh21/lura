// Package ratelimit is a per-key token bucket.
//
// HLD §5.2 requires /pub to rate-limit per device. The limit is per device
// rather than per IP because a household NATs many devices behind one address,
// and a runaway device is the failure mode worth containing.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a keyed token-bucket limiter, safe for concurrent use.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	ratePerSec float64
	burst      float64
	idleTTL    time.Duration
	now        func() time.Time

	lastSweep time.Time
}

type bucket struct {
	tokens float64
	last   time.Time
}

// New returns a limiter allowing ratePerMin sustained events per key with the
// given burst allowance.
func New(ratePerMin, burst int) *Limiter {
	if ratePerMin < 1 {
		ratePerMin = 1
	}
	if burst < 1 {
		burst = 1
	}
	return &Limiter{
		buckets:    map[string]*bucket{},
		ratePerSec: float64(ratePerMin) / 60,
		burst:      float64(burst),
		idleTTL:    30 * time.Minute,
		now:        time.Now,
	}
}

// WithClock overrides the clock (tests).
func (l *Limiter) WithClock(now func() time.Time) *Limiter {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.now = now
	return l
}

// Allow consumes one token for key, reporting whether it was available.
func (l *Limiter) Allow(key string) bool {
	return l.AllowN(key, 1)
}

// AllowN consumes n tokens for key.
func (l *Limiter) AllowN(key string, n float64) bool {
	now := l.now()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[key]
	if !ok {
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}

	// Refill for the elapsed time, capped at the burst size.
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens += elapsed * l.ratePerSec
		if b.tokens > l.burst {
			b.tokens = l.burst
		}
		b.last = now
	}

	l.sweepLocked(now)

	if b.tokens < n {
		return false
	}
	b.tokens -= n
	return true
}

// Retry reports how long the caller should wait before one token is available,
// so the API can send a useful Retry-After.
func (l *Limiter) Retry(key string) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	b, ok := l.buckets[key]
	if !ok || b.tokens >= 1 {
		return 0
	}
	need := 1 - b.tokens
	return time.Duration(need / l.ratePerSec * float64(time.Second))
}

// sweepLocked evicts buckets nobody has touched recently, so a long-lived
// process that has seen many devices does not leak a map entry per device.
func (l *Limiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < l.idleTTL {
		return
	}
	l.lastSweep = now
	for k, b := range l.buckets {
		if now.Sub(b.last) > l.idleTTL {
			delete(l.buckets, k)
		}
	}
}

// Len reports the number of tracked keys (tests, /healthz).
func (l *Limiter) Len() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.buckets)
}
