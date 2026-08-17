// Package gate is the atomic suppression primitive behind geofence cool-off.
//
// HLD §5.4 specifies cool-off as an atomic `SET key NX EX=cooloff` in Valkey:
// only the caller that wins the NX may fire, which closes the race even when
// per-device partitioning is briefly violated (a worker rebalance, a restart
// window). Phase 1 runs one process, so the winner is decided by a mutex here
// instead of by Valkey — behind the same interface, so Phase 2 swaps the
// implementation and not its callers.
package gate

import (
	"context"
	"sync"
	"time"
)

// Gate decides which caller is allowed to act.
type Gate interface {
	// Acquire atomically claims key for ttl. It reports true exactly once per
	// ttl window, to exactly one caller.
	Acquire(ctx context.Context, key string, ttl time.Duration) (bool, error)
	// Release drops a claim early (e.g. an exit should let a re-entry fire).
	Release(ctx context.Context, key string) error
	// TTL reports the remaining lifetime of a claim, 0 if unclaimed.
	TTL(ctx context.Context, key string) (time.Duration, error)
}

// Memory is an in-process Gate.
type Memory struct {
	mu         sync.Mutex
	claims     map[string]time.Time
	now        func() time.Time
	swept      time.Time
	sweepEvery time.Duration
}

// NewMemory returns an in-process gate.
func NewMemory() *Memory {
	return &Memory{
		claims:     map[string]time.Time{},
		now:        time.Now,
		sweepEvery: time.Minute,
	}
}

// WithClock overrides the clock (tests).
func (m *Memory) WithClock(now func() time.Time) *Memory {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.now = now
	return m
}

// Acquire implements Gate.
func (m *Memory) Acquire(_ context.Context, key string, ttl time.Duration) (bool, error) {
	if ttl <= 0 {
		return true, nil // cool-off disabled
	}
	now := m.now()

	m.mu.Lock()
	defer m.mu.Unlock()
	m.sweepLocked(now)

	if until, held := m.claims[key]; held && until.After(now) {
		return false, nil
	}
	m.claims[key] = now.Add(ttl)
	return true, nil
}

// Release implements Gate.
func (m *Memory) Release(_ context.Context, key string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.claims, key)
	return nil
}

// TTL implements Gate.
func (m *Memory) TTL(_ context.Context, key string) (time.Duration, error) {
	now := m.now()
	m.mu.Lock()
	defer m.mu.Unlock()
	until, held := m.claims[key]
	if !held || !until.After(now) {
		return 0, nil
	}
	return until.Sub(now), nil
}

// sweepLocked drops expired claims so the map does not grow with every
// (device, place, trigger) triple ever seen.
func (m *Memory) sweepLocked(now time.Time) {
	if now.Sub(m.swept) < m.sweepEvery {
		return
	}
	m.swept = now
	for k, until := range m.claims {
		if !until.After(now) {
			delete(m.claims, k)
		}
	}
}

// Len reports the number of live claims (tests, /healthz).
func (m *Memory) Len() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.claims)
}

var _ Gate = (*Memory)(nil)
