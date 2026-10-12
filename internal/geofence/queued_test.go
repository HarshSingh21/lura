package geofence_test

import (
	"context"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// A phone back from a tunnel uploads what it recorded *now*: the server
// receives the fix this instant, but the device took it half an hour ago. That
// arrival already happened and must not be announced (HLD §5.4) — the device's
// own time, when it is the older of the two, is the fix's age.
func TestQueuedFixIsJudgedByWhenItWasTaken(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	now := h.clock.Now()
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: now, DeviceTS: now.Add(-30 * time.Minute), Point: inside(),
	}); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a fix taken 30 min ago fired %v", got)
	}

	// A device clock in the future cannot make a fix younger than its arrival:
	// it is simply evaluated as received.
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: now.Add(time.Second), DeviceTS: now.Add(time.Hour), Point: inside(),
	}); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	want(t, h.triggers(), domain.TriggerArrive)
}

// Ingest marks a fix that is older than the device's newest as Late; the engine
// must not let it rewind the inside set even though its receive time is new.
func TestLateFixIsNotEvaluated(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive, domain.TriggerLeave)
	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
	h.reset()

	h.clock.Advance(time.Second)
	now := h.clock.Now()
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: now, DeviceTS: now.Add(-20 * time.Second), Point: outside(), Late: true,
	}); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a late fix fired %v", got)
	}
}
