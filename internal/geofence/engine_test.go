package geofence_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// These tests cover the guards HLD v1.1 was written to add: the freshness gate,
// the fly-by debounce, durable dwell timers, and the atomic cool-off. Each one is
// a rule that is easy to state and easy to get wrong, so each gets a test that
// fails loudly if the rule is dropped.

// harness wires an engine to an in-memory store and a fake clock, and collects the
// geo events the engine publishes.
type harness struct {
	t      *testing.T
	store  *memory.Store
	bus    *bus.InProcess
	engine *geofence.Engine
	clock  *fakeClock

	mu     sync.Mutex
	events []domain.GeoEvent
	sub    bus.Subscription
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

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

const (
	testUser   = "u1"
	testDevice = "d1"
)

func newHarness(t *testing.T, cfg geofence.Config) *harness {
	t.Helper()

	st := memory.New()
	ctx := context.Background()
	if err := st.UpsertUser(ctx, domain.User{ID: testUser, TZ: "UTC"}); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := st.UpsertDevice(ctx, domain.Device{
		ID: testDevice, UserID: testUser, Name: "Phone", Token: "tok",
	}); err != nil {
		t.Fatalf("seed device: %v", err)
	}

	b := bus.NewInProcess(nil)
	clock := &fakeClock{now: time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)}
	engine := geofence.New(st, b, gate.NewMemory().WithClock(clock.Now), nil, cfg).WithClock(clock.Now)

	h := &harness{t: t, store: st, bus: b, engine: engine, clock: clock}

	// Subscribing to the durable path: that is where a geo event must land, since
	// losing one loses a reminder.
	sub, err := b.SubscribePartitioned(bus.GeoAll(), 1, bus.UserKey, func(m bus.Msg) {
		var ev domain.GeoEvent
		if err := json.Unmarshal(m.Data, &ev); err != nil {
			t.Errorf("undecodable geo event: %v", err)
			return
		}
		h.mu.Lock()
		h.events = append(h.events, ev)
		h.mu.Unlock()
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	h.sub = sub
	t.Cleanup(func() { sub.Unsubscribe(); _ = b.Close() })
	return h
}

// place creates a geofence at a fixed location.
func (h *harness) place(id, name string, radius int, triggers ...domain.Trigger) domain.Place {
	h.t.Helper()
	p, err := h.store.CreatePlace(context.Background(), domain.Place{
		ID: id, UserID: testUser, Name: name,
		Center:   domain.Point{Lat: 12.9611, Lon: 77.6387},
		RadiusM:  radius,
		Triggers: triggers,
	})
	if err != nil {
		h.t.Fatalf("create place: %v", err)
	}
	return p
}

// inside is a point at the centre of the fences created by place().
func inside() domain.Point { return domain.Point{Lat: 12.9611, Lon: 77.6387} }

// outside is ~1.1 km away: outside any fence these tests create.
func outside() domain.Point { return domain.Point{Lat: 12.9711, Lon: 77.6387} }

// fix evaluates one position at the current fake time.
func (h *harness) fix(pt domain.Point, speed float64) {
	h.t.Helper()
	h.fixAt(pt, speed, h.clock.Now())
}

// fixAt evaluates one position stamped with an explicit recv_ts.
func (h *harness) fixAt(pt domain.Point, speed float64, recv time.Time) {
	h.t.Helper()
	err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: testDevice, UserID: testUser,
		RecvTS: recv, DeviceTS: recv, Point: pt, SpeedMPS: speed,
	})
	if err != nil {
		h.t.Fatalf("evaluate: %v", err)
	}
}

// triggers waits briefly for the async bus delivery and returns what fired.
func (h *harness) triggers() []domain.Trigger {
	h.t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		h.mu.Lock()
		n := len(h.events)
		h.mu.Unlock()
		// Settle: the events arrive on a worker goroutine, so poll until the count
		// stops changing rather than sleeping a fixed amount.
		time.Sleep(15 * time.Millisecond)
		h.mu.Lock()
		stable := len(h.events) == n
		h.mu.Unlock()
		if stable || time.Now().After(deadline) {
			break
		}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]domain.Trigger, 0, len(h.events))
	for _, e := range h.events {
		out = append(out, e.Trigger)
	}
	return out
}

func (h *harness) reset() {
	h.mu.Lock()
	h.events = nil
	h.mu.Unlock()
}

func baseConfig() geofence.Config {
	return geofence.Config{
		FreshWindow:       5 * time.Minute,
		ArriveDebounce:    45 * time.Second,
		ArriveMaxSpeedMPS: 1.5,
		PassbyMinSpeedMPS: 3,
		CoolOff:           30 * time.Minute,
		DwellTick:         time.Hour, // the tests drive dwell explicitly
		Partitions:        1,
	}
}

func want(t *testing.T, got []domain.Trigger, expect ...domain.Trigger) {
	t.Helper()
	if len(got) != len(expect) {
		t.Fatalf("triggers = %v, want %v", got, expect)
	}
	for i := range expect {
		if got[i] != expect[i] {
			t.Fatalf("triggers = %v, want %v", got, expect)
		}
	}
}

// ---------------------------------------------------------------- freshness

// A replayed fix from an offline phone must fill in history but never announce an
// arrival that already happened (HLD §5.4, "Freshness gate").
func TestFreshnessGateDropsStaleFix(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	stale := h.clock.Now().Add(-30 * time.Minute)
	h.fixAt(inside(), 0, stale)

	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("stale fix fired %v, want nothing", got)
	}
	// And it must not have polluted the inside set either, or the next fresh fix
	// would look like "already inside" and never fire an arrival.
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 0 {
		t.Fatalf("stale fix updated the inside set: %v", places)
	}

	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
}

// Within the fresh window, an out-of-order fix must not rewind the inside set.
func TestOutOfOrderFixIgnored(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive, domain.TriggerLeave)

	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
	h.reset()

	// An older "outside" fix arrives late. Acting on it would fire a bogus leave.
	h.fixAt(outside(), 5, h.clock.Now().Add(-time.Minute))
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("out-of-order fix fired %v, want nothing", got)
	}
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 1 {
		t.Fatalf("inside set = %v, want still inside p1", places)
	}
}

// ---------------------------------------------------------------- fly-by filter

// Driving through a fence at speed is not an arrival. The reminder waits for the
// device to slow down — which is why the HLD measures its < 2 s NFR from the
// confirming fix rather than from first entry (HLD §2.2 note, §5.4).
func TestArriveWaitsForSlowDown(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	h.fix(inside(), 12) // 43 km/h: passing through
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("fast entry fired %v, want nothing yet", got)
	}

	h.clock.Advance(10 * time.Second)
	h.fix(inside(), 8) // still moving
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("still-moving fix fired %v, want nothing yet", got)
	}

	h.clock.Advance(10 * time.Second)
	h.fix(inside(), 0.5) // parked
	want(t, h.triggers(), domain.TriggerArrive)
}

// Sitting in traffic inside a large fence eventually counts as an arrival, even
// without a slow fix: the debounce is "slow OR stayed", not "slow AND stayed".
func TestArriveConfirmsAfterDebounceWindow(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Office", 200, domain.TriggerArrive)

	h.fix(inside(), 10)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("fast entry fired %v, want nothing yet", got)
	}

	h.clock.Advance(50 * time.Second) // past ArriveDebounce
	h.fix(inside(), 9)                // never slowed down
	want(t, h.triggers(), domain.TriggerArrive)
}

// A slow entry (walking in) needs no debounce at all.
func TestArriveImmediateWhenSlow(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	h.fix(inside(), 1.0)
	want(t, h.triggers(), domain.TriggerArrive)
}

// ---------------------------------------------------------------- pass-by

// Pass-by is enter-while-moving: the Phase 1 place-level approximation of the
// route corridors in HLD §5.5.
func TestPassbyFiresOnlyWhileMoving(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Whole Foods", 60, domain.TriggerPassby)

	// Walking in slowly is a visit, not a pass-by.
	h.fix(inside(), 1)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("slow entry fired %v, want no pass-by", got)
	}

	// Leave and drive through.
	h.clock.Advance(time.Minute)
	h.fix(outside(), 1)
	h.clock.Advance(time.Minute)
	h.reset()
	h.fix(inside(), 12)
	want(t, h.triggers(), domain.TriggerPassby)
}

// ---------------------------------------------------------------- leave

func TestLeaveFiresOnExit(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerLeave)

	h.fix(inside(), 0)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("entering fired %v, want nothing (leave only)", got)
	}

	h.clock.Advance(time.Minute)
	h.fix(outside(), 6)
	want(t, h.triggers(), domain.TriggerLeave)
}

// ---------------------------------------------------------------- cool-off

// GPS jitter on a fence boundary must produce one reminder, not twelve
// (HLD §5.4, "Cool-off (atomic)").
func TestCoolOffSuppressesRepeatArrive(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive, domain.TriggerLeave)

	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
	h.reset()

	// Jitter out and back in, twice, well inside the cool-off window.
	for i := 0; i < 2; i++ {
		h.clock.Advance(20 * time.Second)
		h.fix(outside(), 2)
		h.clock.Advance(20 * time.Second)
		h.fix(inside(), 0)
	}

	// Leave fires each time (it has its own cool-off key and this place arms it),
	// but arrive must be suppressed for the rest of the window.
	for _, tr := range h.triggers() {
		if tr == domain.TriggerArrive {
			t.Fatalf("arrive re-fired inside the cool-off window: %v", h.triggers())
		}
	}

	// Once the cool-off has expired, a genuine return fires again.
	h.clock.Advance(31 * time.Minute)
	h.reset()
	h.fix(outside(), 3)
	h.clock.Advance(time.Minute)
	h.fix(inside(), 0)
	found := false
	for _, tr := range h.triggers() {
		if tr == domain.TriggerArrive {
			found = true
		}
	}
	if !found {
		t.Fatalf("arrive did not fire after the cool-off expired: %v", h.triggers())
	}
}

// ---------------------------------------------------------------- dwell

// Dwell is a timer armed on enter, persisted in the store (not a cache) so a
// restart cannot lose it — HLD §17 lists cache-only dwell as a known risk.
func TestDwellArmsPersistsAndFires(t *testing.T) {
	cfg := baseConfig()
	h := newHarness(t, cfg)
	h.place("p_gym", "Gym", 80, domain.TriggerDwell)

	// Arming happens on entry.
	h.fix(inside(), 0)
	pending, err := h.store.ListPendingDwells(context.Background(), testUser)
	if err != nil {
		t.Fatalf("ListPendingDwells: %v", err)
	}
	if len(pending) != 1 {
		t.Fatalf("armed %d dwell timers, want 1", len(pending))
	}
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("dwell fired immediately: %v", got)
	}

	// Not due yet.
	h.engine.RunDueDwellsForTest(context.Background())
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("dwell fired early: %v", got)
	}

	// Once the timer matures and the device is still inside, it fires.
	h.clock.Advance(16 * time.Minute) // DefaultDwell is 15 minutes
	h.engine.RunDueDwellsForTest(context.Background())
	want(t, h.triggers(), domain.TriggerDwell)

	// The timer is spent: a second sweep must not fire it again.
	h.reset()
	h.engine.RunDueDwellsForTest(context.Background())
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("dwell fired twice: %v", got)
	}
}

// Leaving before the timer matures cancels it: no "you are still at the gym" for
// someone who left after five minutes.
func TestDwellCancelledOnExit(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p_gym", "Gym", 80, domain.TriggerDwell)

	h.fix(inside(), 0)
	h.clock.Advance(2 * time.Minute)
	h.fix(outside(), 5)

	pending, err := h.store.ListPendingDwells(context.Background(), testUser)
	if err != nil {
		t.Fatalf("ListPendingDwells: %v", err)
	}
	if len(pending) != 0 {
		t.Fatalf("dwell timer survived the exit: %+v", pending)
	}

	h.clock.Advance(30 * time.Minute)
	h.engine.RunDueDwellsForTest(context.Background())
	for _, tr := range h.triggers() {
		if tr == domain.TriggerDwell {
			t.Fatal("dwell fired after the device had left")
		}
	}
}

// A dwell timer reloaded after a restart has no in-memory state to consult, so
// the engine falls back to the device's last known point.
func TestDwellAfterRestartUsesLastKnownPoint(t *testing.T) {
	h := newHarness(t, baseConfig())
	place := h.place("p_gym", "Gym", 80, domain.TriggerDwell)

	ctx := context.Background()
	entered := h.clock.Now().Add(-30 * time.Minute)
	if err := h.store.PutPendingDwell(ctx, domain.PendingDwell{
		DeviceID: testDevice, UserID: testUser, PlaceID: place.ID,
		EnteredAt: entered, FireAt: entered.Add(15 * time.Minute),
	}); err != nil {
		t.Fatalf("PutPendingDwell: %v", err)
	}

	// The device's last fix is inside the fence and recent, so the reminder is
	// still valid.
	if _, err := h.store.TouchLastPoint(ctx, testDevice, inside(), h.clock.Now().Add(-time.Minute), 0, 80); err != nil {
		t.Fatalf("TouchLastPoint: %v", err)
	}

	h.engine.RunDueDwellsForTest(ctx)
	want(t, h.triggers(), domain.TriggerDwell)
}

// The same reload, but the device is nowhere near the place any more: the timer
// is discarded silently.
func TestDwellAfterRestartSkipsWhenAway(t *testing.T) {
	h := newHarness(t, baseConfig())
	place := h.place("p_gym", "Gym", 80, domain.TriggerDwell)

	ctx := context.Background()
	entered := h.clock.Now().Add(-30 * time.Minute)
	if err := h.store.PutPendingDwell(ctx, domain.PendingDwell{
		DeviceID: testDevice, UserID: testUser, PlaceID: place.ID,
		EnteredAt: entered, FireAt: entered.Add(15 * time.Minute),
	}); err != nil {
		t.Fatalf("PutPendingDwell: %v", err)
	}
	if _, err := h.store.TouchLastPoint(ctx, testDevice, outside(), h.clock.Now().Add(-time.Minute), 8, 80); err != nil {
		t.Fatalf("TouchLastPoint: %v", err)
	}

	h.engine.RunDueDwellsForTest(ctx)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("dwell fired for a device that had left: %v", got)
	}
	if pending, _ := h.store.ListPendingDwells(ctx, testUser); len(pending) != 0 {
		t.Errorf("spent timer not cleared: %+v", pending)
	}
}

// ---------------------------------------------------------------- misc

// A place with several triggers can fire more than one event for one visit.
func TestMultipleTriggersOnOnePlace(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive, domain.TriggerLeave, domain.TriggerPassby)

	h.fix(inside(), 10) // driving in: pass-by fires, arrive is held
	want(t, h.triggers(), domain.TriggerPassby)

	h.clock.Advance(10 * time.Second)
	h.reset()
	h.fix(inside(), 0) // parked: arrive confirms
	want(t, h.triggers(), domain.TriggerArrive)

	h.clock.Advance(time.Minute)
	h.reset()
	h.fix(outside(), 8) // gone: leave fires
	want(t, h.triggers(), domain.TriggerLeave)
}

// Overlapping fences both evaluate: a shop inside a district is inside both.
func TestOverlappingFencesBothFire(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p_small", "Shop", 60, domain.TriggerArrive)
	h.place("p_big", "District", 1000, domain.TriggerArrive)

	h.fix(inside(), 0)
	got := h.triggers()
	if len(got) != 2 {
		t.Fatalf("triggers = %v, want two arrivals", got)
	}
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 2 {
		t.Errorf("inside set = %v, want both fences", places)
	}
}

// A place with no matching trigger armed produces no events at all, however the
// device moves through it.
func TestPlaceWithoutTriggerNeverFires(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Passive", 120) // no triggers

	h.fix(inside(), 0)
	h.clock.Advance(time.Minute)
	h.fix(outside(), 5)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("a place with no triggers fired %v", got)
	}
}

// The engine must survive a store that has no places at all.
func TestNoPlacesIsNotAnError(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.fix(inside(), 3)
	if got := h.triggers(); len(got) != 0 {
		t.Fatalf("fired %v with no places configured", got)
	}
}

// Deleting a device's state (as the API does on delete) must not leak into the
// next device with the same id.
func TestForgetClearsState(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.place("p1", "Home", 120, domain.TriggerArrive)

	h.fix(inside(), 0)
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 1 {
		t.Fatalf("inside set = %v, want one fence", places)
	}
	h.engine.Forget(testDevice)
	if places := h.engine.InsideSnapshot()[testDevice]; len(places) != 0 {
		t.Errorf("state survived Forget: %v", places)
	}
}

// compile-time check that the store used here satisfies the full interface
var _ store.Store = (*memory.Store)(nil)
