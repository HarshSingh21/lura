package geofence_test

import (
	"context"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// A phone back from a tunnel uploads what it recorded *now*: the server
// receives the fix this instant, but the device was there half an hour ago
// (ingest's FixTS). That arrival already happened and must not be announced
// (HLD §5.4).
func TestQueuedFixIsJudgedByWhenItWasTaken(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	now := h.clock.Now()
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: now, DeviceTS: now.Add(-30 * time.Minute), FixTS: now.Add(-30 * time.Minute), Point: inside(),
	}); err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a fix taken 30 min ago fired %v", got)
	}

	// A device whose clock is simply wrong — here an hour behind, but sending
	// live (ingest learnt the offset, so FixTS is the arrival) — is news.
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: now.Add(time.Second), DeviceTS: now.Add(-time.Hour), FixTS: now.Add(time.Second), Point: inside(),
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

// Fixes a phone queued and uploads in one burst arrive milliseconds apart; the
// crossing rule must time the step between them by when they were taken, or a
// pass-by between two queued fixes reads as a 3 km/s teleport and is dropped.
func TestCrossingInAQueuedBurstIsTimedByTheDevice(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Grocery", 40, domain.TriggerPassby)

	now := h.clock.Now()
	burst := []struct {
		pt    domain.Point
		taken time.Time
		recv  time.Time
	}{
		{at(270, 80), now.Add(-20 * time.Second), now},                           // 160 m apart,
		{at(90, 80), now.Add(-10 * time.Second), now.Add(50 * time.Millisecond)}, // 10 s apart on the device
	}
	for _, f := range burst {
		if err := h.engine.Evaluate(context.Background(), domain.Position{
			DeviceID: testDevice, UserID: testUser,
			RecvTS: f.recv, DeviceTS: f.taken, FixTS: f.taken, Point: f.pt, SpeedMPS: 15,
		}); err != nil {
			t.Fatalf("evaluate: %v", err)
		}
	}
	want(t, h.triggers(), domain.TriggerPassby)
}
