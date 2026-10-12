package geofence_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
)

// Edge cases from the end-to-end edge suite (e2e/edge-fences-ui.mjs): a phone
// standing on a fence's edge, a fast pass-by with one or zero fixes inside, a
// fence moved or deleted while someone is in it.

// at is the point distM metres from the test fences' centre along bearing.
func at(bearing, distM float64) domain.Point {
	c := inside()
	lat, lon := geo.Destination(c.Lat, c.Lon, bearing, distM)
	return domain.Point{Lat: lat, Lon: lon}
}

func fixAcc(h *harness, pt domain.Point, speed, acc float64) {
	h.t.Helper()
	err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: h.clock.Now(), DeviceTS: h.clock.Now(), Point: pt, SpeedMPS: speed, AccuracyM: acc,
	})
	if err != nil {
		h.t.Fatalf("evaluate: %v", err)
	}
}

func count(got []domain.Trigger, t domain.Trigger) int {
	n := 0
	for _, g := range got {
		if g == t {
			n++
		}
	}
	return n
}

// A phone parked on the boundary with ±8 m of GPS noise, for two minutes, is
// one arrival — not an arrive/leave pair every time a fix lands outside. The
// cool-off is set short on purpose: the geometry has to hold this, not the
// cool-off.
func TestBoundaryJitterIsOneArrivalAndNoLeave(t *testing.T) {
	cfg := baseConfig()
	cfg.CoolOff = time.Second
	h := newHarness(t, cfg)
	h.place("p1", "Grocery", 100, domain.TriggerArrive, domain.TriggerLeave)

	fixAcc(h, at(90, 300), 1.2, 7) // well outside, walking up
	for i := 0; i < 60; i++ {      // 2 minutes, a fix every 2 s
		h.clock.Advance(2 * time.Second)
		jitter := 8 * math.Sin(float64(i)*1.7) // −8 … +8 m across the edge
		fixAcc(h, at(90+float64(i%7), 100+jitter), 0, 7)
	}
	got := h.triggers()
	if count(got, domain.TriggerArrive) != 1 || count(got, domain.TriggerLeave) != 0 {
		t.Fatalf("hovering on the edge fired %v, want exactly one arrive and no leave", got)
	}

	// Walking away for real is one leave.
	h.reset()
	for _, d := range []float64{112, 125, 160, 220} {
		h.clock.Advance(5 * time.Second)
		fixAcc(h, at(90, d), 1.3, 7)
	}
	want(t, h.triggers(), domain.TriggerLeave)
}

// A fix with poor accuracy widens the hysteresis, but never past
// MaxLeaveMarginM.
func TestLeaveMarginFollowsAccuracyWithACap(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Grocery", 100, domain.TriggerLeave)
	fixAcc(h, inside(), 0, 5)

	h.clock.Advance(10 * time.Second)
	fixAcc(h, at(0, 135), 0, 40) // 35 m out, ±40 m: could still be inside
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a fix within its own accuracy of the edge fired %v", got)
	}
	h.clock.Advance(10 * time.Second)
	fixAcc(h, at(0, 160), 0, 500) // 60 m out: beyond the 50 m cap, whatever the accuracy
	want(t, h.triggers(), domain.TriggerLeave)
}

// Driving through a fence is a pass-by. It is not a visit, so it has no leave.
func TestFlyByFiresPassbyButNoLeave(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Grocery", 60, domain.TriggerArrive, domain.TriggerLeave, domain.TriggerPassby)

	h.fix(at(270, 90), 15)
	h.clock.Advance(5 * time.Second)
	h.fix(at(270, 10), 15) // the one fix inside
	h.clock.Advance(5 * time.Second)
	h.fix(at(90, 70), 15)
	h.clock.Advance(5 * time.Second)
	h.fix(at(90, 150), 15)
	want(t, h.triggers(), domain.TriggerPassby)
}

// A visit that never slowed down but stayed past the debounce still settles,
// so its leave fires.
func TestSlowVisitWithoutArriveTriggerStillLeaves(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Grocery", 120, domain.TriggerLeave)
	h.fix(inside(), 2)
	h.clock.Advance(50 * time.Second)
	h.fix(inside(), 2)
	h.clock.Advance(10 * time.Second)
	h.fix(outside(), 2)
	want(t, h.triggers(), domain.TriggerLeave)
}

// No fix inside at all: the fixes straddle the fence. The straight path
// between them went through it, so that is a pass-by.
func TestCrossingBetweenFixesIsPassby(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Grocery", 40, domain.TriggerArrive, domain.TriggerLeave, domain.TriggerPassby)

	h.fix(at(270, 80), 15)
	h.clock.Advance(10 * time.Second) // 160 m in 10 s: 16 m/s
	h.fix(at(90, 80), 15)
	want(t, h.triggers(), domain.TriggerPassby)
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 0 {
		t.Fatalf("a crossing left inside-state behind: %v", places)
	}
}

func TestCrossingPolygonBetweenFixes(t *testing.T) {
	h := newHarness(t, baseConfig())
	ring := []domain.Point{at(315, 42), at(45, 42), at(135, 42), at(225, 42)} // a 60 m square
	_, err := h.store.CreatePlace(context.Background(), domain.Place{
		ID: "sq", UserID: testUser, Name: "Kiosk", Shape: domain.ShapePolygon, Polygon: ring,
		Center: inside(), RadiusM: 43, Triggers: []domain.Trigger{domain.TriggerPassby},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.fix(at(0, 70), 14)
	h.clock.Advance(10 * time.Second)
	h.fix(at(180, 70), 14)
	want(t, h.triggers(), domain.TriggerPassby)

	// A path that misses the square by 20 m is nothing.
	h.reset()
	h.clock.Advance(time.Minute)
	h.fix(at(90, 60), 14)
	h.clock.Advance(10 * time.Second)
	h.fix(domain.Point{Lat: at(90, 60).Lat - 0.0013, Lon: at(90, 60).Lon}, 14)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a path past the square fired %v", got)
	}
}

// The straight line between fixes is only the path when it plausibly is.
func TestCrossingNeedsAPlausiblePath(t *testing.T) {
	cases := []struct {
		name  string
		gap   time.Duration
		speed float64
	}{
		{"fixes ten minutes apart", 10 * time.Minute, 15},
		{"a jump no vehicle makes", time.Second, 15}, // 160 m in 1 s
		{"walking pace", 80 * time.Second, 0},        // 160 m in 80 s: 2 m/s
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, baseConfig())
			h.place("p1", "Grocery", 40, domain.TriggerPassby)
			h.fix(at(270, 80), tc.speed)
			h.clock.Advance(tc.gap)
			h.fix(at(90, 80), tc.speed)
			if got := h.triggers(); len(got) != 0 {
				t.Fatalf("fired %v, want nothing", got)
			}
		})
	}
}

// Moving a fence away from someone inside it is a leave on the next fix — once.
func TestMovedFenceLeavesOnceOnNextFix(t *testing.T) {
	h := newHarness(t, baseConfig())
	p := h.place("p1", "Grocery", 80, domain.TriggerArrive, domain.TriggerLeave)
	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)

	far := at(0, 300)
	p.Center = far
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	h.reset()
	for i := 0; i < 3; i++ {
		h.clock.Advance(5 * time.Second)
		h.fix(inside(), 0)
	}
	want(t, h.triggers(), domain.TriggerLeave)

	// Growing it back over her is an arrival again (the arrive cool-off is
	// per trigger, so wait it out as a real return would).
	h.clock.Advance(31 * time.Minute)
	p.Center = inside()
	p.RadiusM = 400
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	h.reset()
	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
}

// Deleting a fence someone is inside, with a dwell timer pending, fires
// nothing: no leave, no dwell, now or later.
func TestDeletedFenceIsSilent(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Gym", 80, domain.TriggerLeave, domain.TriggerDwell)
	h.fix(inside(), 0)
	if err := h.store.DeletePlace(context.Background(), testUser, "p1"); err != nil {
		t.Fatal(err)
	}
	h.clock.Advance(20 * time.Minute)
	h.fix(outside(), 3)
	h.engine.RunDueDwellsForTest(context.Background())
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a deleted fence fired %v", got)
	}
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 0 {
		t.Fatalf("stale inside-state for a deleted fence: %v", places)
	}
}
