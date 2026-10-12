package geofence_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
)

// These tests cover what this release adds to the engine: drawn polygons,
// fences that move under a device, and evaluating a connected person's fixes
// against the fences of someone who watches them — under that person's consent.

const (
	peerUser   = "u2"
	peerDevice = "d2"
)

// lShape is a concave ~110 m L whose north-east notch is inside its bounding
// circle but outside the ring.
func lShape() []domain.Point {
	return []domain.Point{
		{Lat: 12.9600, Lon: 77.6380}, {Lat: 12.9600, Lon: 77.6390}, {Lat: 12.9605, Lon: 77.6390},
		{Lat: 12.9605, Lon: 77.6385}, {Lat: 12.9610, Lon: 77.6385}, {Lat: 12.9610, Lon: 77.6380},
	}
}

var (
	inUpright = domain.Point{Lat: 12.9608, Lon: 77.6382}
	inNotch   = domain.Point{Lat: 12.9608, Lon: 77.6388}
	pastL     = domain.Point{Lat: 12.9620, Lon: 77.6382}
)

func (h *harness) polygon(id, name string, ring []domain.Point, triggers ...domain.Trigger) domain.Place {
	h.t.Helper()
	p, err := h.store.CreatePlace(context.Background(), domain.Place{
		ID: id, UserID: testUser, Name: name,
		Shape: domain.ShapePolygon, Polygon: ring,
		Center: domain.Point{Lat: 12.9605, Lon: 77.6385}, RadiusM: 80,
		Triggers: triggers,
	})
	if err != nil {
		h.t.Fatalf("create polygon: %v", err)
	}
	return p
}

// withPeer adds Nishtha (u2, device d2) and connects her to u1. sharing is
// *her* switch — whether u1 may see her.
func (h *harness) withPeer(sharing bool) {
	h.t.Helper()
	ctx := context.Background()
	if err := h.store.UpsertUser(ctx, domain.User{ID: peerUser, DisplayName: "Nishtha", TZ: "UTC"}); err != nil {
		h.t.Fatalf("seed peer: %v", err)
	}
	if err := h.store.UpsertDevice(ctx, domain.Device{ID: peerDevice, UserID: peerUser, Name: "Nishtha's Phone", Token: "tok2"}); err != nil {
		h.t.Fatalf("seed peer device: %v", err)
	}
	for _, c := range []domain.Connection{
		{UserID: testUser, PeerID: peerUser, PeerName: "Nishtha", Status: domain.ConnectionAccepted, Sharing: true},
		{UserID: peerUser, PeerID: testUser, PeerName: "Harsh", Status: domain.ConnectionAccepted, Sharing: sharing},
	} {
		if _, err := h.store.UpsertConnection(ctx, c); err != nil {
			h.t.Fatalf("seed connection: %v", err)
		}
	}
}

func (h *harness) setPeerSharing(sharing bool) {
	h.t.Helper()
	ctx := context.Background()
	c, err := h.store.GetConnection(ctx, peerUser, testUser)
	if err != nil {
		h.t.Fatalf("get connection: %v", err)
	}
	c.Sharing = sharing
	if _, err := h.store.UpsertConnection(ctx, c); err != nil {
		h.t.Fatalf("update connection: %v", err)
	}
}

// peerFix evaluates one of Nishtha's fixes at the current fake time.
func (h *harness) peerFix(pt domain.Point, speed float64) {
	h.t.Helper()
	now := h.clock.Now()
	if err := h.engine.Evaluate(context.Background(), domain.Position{
		DeviceID: peerDevice, UserID: peerUser,
		RecvTS: now, DeviceTS: now, Point: pt, SpeedMPS: speed,
	}); err != nil {
		h.t.Fatalf("evaluate peer fix: %v", err)
	}
}

func (h *harness) geoEvents() []domain.GeoEvent {
	h.t.Helper()
	h.triggers() // settle
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]domain.GeoEvent(nil), h.events...)
}

// subjects records which bus subject each geo event was published on, which is
// the privacy boundary: geo.<user> is what that user's socket receives.
type subjects struct {
	mu   sync.Mutex
	seen []string
}

func (h *harness) recordSubjects() *subjects {
	h.t.Helper()
	rec := &subjects{}
	sub, err := h.bus.Subscribe(bus.GeoAll(), func(m bus.Msg) {
		rec.mu.Lock()
		rec.seen = append(rec.seen, m.Subject)
		rec.mu.Unlock()
	})
	if err != nil {
		h.t.Fatalf("subscribe: %v", err)
	}
	h.t.Cleanup(sub.Unsubscribe)
	return rec
}

func (s *subjects) list() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.seen...)
}

// ---------------------------------------------------------------- polygons

func TestPolygonArriveAndLeave(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.polygon("p_l", "Grocery", lShape(), domain.TriggerArrive, domain.TriggerLeave)

	// The notch is inside the bounding circle; a circle approximation would
	// call this an arrival.
	h.fix(inNotch, 0)
	want(t, h.triggers())

	h.clock.Advance(time.Second)
	h.fix(inUpright, 0)
	want(t, h.triggers(), domain.TriggerArrive)
	if got := h.engine.InsideSnapshot()[testDevice]; len(got) != 1 || got[0] != "p_l" {
		t.Fatalf("inside = %v, want [p_l]", got)
	}

	// Walking into the notch is leaving the polygon.
	h.clock.Advance(time.Second)
	h.fix(inNotch, 0)
	want(t, h.triggers(), domain.TriggerArrive, domain.TriggerLeave)
}

func TestPolygonPassby(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.polygon("p_l", "Grocery", lShape(), domain.TriggerPassby)

	h.fix(pastL, 12)
	h.clock.Advance(time.Second)
	h.fix(inUpright, 12)
	h.clock.Advance(time.Second)
	h.fix(domain.Point{Lat: 12.9590, Lon: 77.6382}, 12)
	want(t, h.triggers(), domain.TriggerPassby)
}

// ---------------------------------------------------------------- moved fences

// A fence dragged away from a device that was inside it must produce a normal
// leave on the next fix — not stale "still inside" state.
func TestMovedFenceLeavesOnNextFix(t *testing.T) {
	h := newHarness(t, baseConfig())
	p := h.place("p1", "Home", 120, domain.TriggerArrive, domain.TriggerLeave)

	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)

	p.Center = domain.Point{Lat: 12.9800, Lon: 77.6387} // ~2 km north
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("move place: %v", err)
	}

	h.clock.Advance(time.Second)
	h.fix(inside(), 0) // the device has not moved
	want(t, h.triggers(), domain.TriggerArrive, domain.TriggerLeave)
	if got := h.engine.InsideSnapshot()[testDevice]; len(got) != 0 {
		t.Fatalf("inside after move = %v, want none", got)
	}
}

// And a fence dragged onto a device is an arrival on the next fix.
func TestFenceMovedOntoDeviceArrives(t *testing.T) {
	h := newHarness(t, baseConfig())
	ctx := context.Background()
	p, err := h.store.CreatePlace(ctx, domain.Place{
		ID: "p_far", UserID: testUser, Name: "Gym",
		Center: domain.Point{Lat: 12.99, Lon: 77.70}, RadiusM: 100,
		Triggers: []domain.Trigger{domain.TriggerArrive},
	})
	if err != nil {
		t.Fatalf("create place: %v", err)
	}
	h.fix(inside(), 0)
	want(t, h.triggers())

	// Reshape it into a polygon around the device.
	p.Shape = domain.ShapePolygon
	p.Polygon = []domain.Point{
		{Lat: 12.9605, Lon: 77.6380}, {Lat: 12.9605, Lon: 77.6395}, {Lat: 12.9620, Lon: 77.6395}, {Lat: 12.9620, Lon: 77.6380},
	}
	p.Center = domain.Point{Lat: 12.96125, Lon: 77.63875}
	p.RadiusM = 120
	if _, err := h.store.UpdatePlace(ctx, p); err != nil {
		t.Fatalf("reshape place: %v", err)
	}
	h.clock.Advance(time.Second)
	h.fix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
}

// ---------------------------------------------------------------- peers

// The headline: Harsh's fence watches Nishtha, she shares live with him, and
// her crossing reaches *his* geo subject with her as the subject.
func TestPeerWatchFiresForOwner(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	rec := h.recordSubjects()
	p := h.polygon("p_l", "Grocery", lShape(), domain.TriggerArrive, domain.TriggerLeave)
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inUpright, 0)
	evs := h.geoEvents()
	if len(evs) != 1 {
		t.Fatalf("events = %+v, want one arrive", evs)
	}
	ev := evs[0]
	if ev.Trigger != domain.TriggerArrive || ev.UserID != testUser || ev.SubjectUserID != peerUser ||
		ev.SubjectName != "Nishtha" || ev.DeviceID != peerDevice || ev.PlaceID != "p_l" {
		t.Fatalf("event = %+v, want arrive owned by u1 about u2/Nishtha on d2", ev)
	}

	h.clock.Advance(time.Second)
	h.peerFix(pastL, 0)
	evs = h.geoEvents()
	if len(evs) != 2 || evs[1].Trigger != domain.TriggerLeave || evs[1].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want arrive then leave", evs)
	}

	seen := rec.list()
	if len(seen) == 0 {
		t.Fatal("no geo event reached the live path")
	}
	for _, s := range seen {
		if s != bus.GeoSubject(testUser) {
			t.Errorf("geo event published on %s: the watched person must not receive the owner's events", s)
		}
	}
}

// The peer's own inside-state is not leaked into her own snapshot: the fence
// is Harsh's.
func TestPeerInsideStateIsNotInPeersSnapshot(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	p := h.place("p1", "Grocery", 120, domain.TriggerArrive)
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)
	if got := h.engine.InsideSnapshot()[peerDevice]; len(got) != 0 {
		t.Fatalf("peer's snapshot lists the watcher's fence: %v", got)
	}
}

// Owner and peer each have their own state per (device, place): Harsh being
// inside his fence does not make Nishtha's arrival a no-op, and vice versa.
func TestOwnerAndPeerStateAreIndependent(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	p := h.place("p1", "Grocery", 120, domain.TriggerArrive, domain.TriggerLeave)
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.fix(inside(), 0)
	h.peerFix(inside(), 0)
	evs := h.geoEvents()
	if len(evs) != 2 || evs[0].SubjectUserID != testUser || evs[1].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want one arrive for each person", evs)
	}

	h.clock.Advance(time.Second)
	h.peerFix(outside(), 0)
	evs = h.geoEvents()
	if len(evs) != 3 || evs[2].Trigger != domain.TriggerLeave || evs[2].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want Nishtha's leave only", evs)
	}
	if got := h.engine.InsideSnapshot()[testDevice]; len(got) != 1 {
		t.Fatalf("Harsh's own state changed when Nishtha left: %v", got)
	}
}

// Without her consent nothing is evaluated, however the fence is configured.
func TestPausedConnectionDoesNotFire(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(false)
	p := h.place("p1", "Grocery", 120, domain.TriggerArrive, domain.TriggerPassby)
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 10)
	h.clock.Advance(time.Second)
	h.peerFix(inside(), 0)
	want(t, h.triggers())
}

// Pausing while inside stops evaluation on the very next fix: no leave is
// announced for a crossing nobody may observe any more.
func TestPausingMidVisitStopsImmediately(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	p := h.place("p1", "Grocery", 120, domain.TriggerArrive, domain.TriggerLeave, domain.TriggerDwell)
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)

	h.setPeerSharing(false)
	h.clock.Advance(time.Second)
	h.peerFix(outside(), 0)
	want(t, h.triggers(), domain.TriggerArrive)

	dwells, err := h.store.ListPendingDwells(context.Background(), testUser)
	if err != nil {
		t.Fatalf("ListPendingDwells: %v", err)
	}
	if len(dwells) != 0 {
		t.Fatalf("pending dwells after pause = %+v, want none", dwells)
	}
}

// A dwell armed while she shared must not fire after she paused, even with no
// fix in between to clear it.
func TestPausedPeerDwellDoesNotFire(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	p := h.place("p1", "Grocery", 120, domain.TriggerDwell)
	p.DwellMins = 5
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 0)
	h.setPeerSharing(false)
	h.clock.Advance(6 * time.Minute)
	h.engine.RunDueDwellsForTest(context.Background())
	want(t, h.triggers())
}

// The same dwell fires for the owner while she keeps sharing.
func TestPeerDwellFiresForOwner(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	p := h.place("p1", "Grocery", 120, domain.TriggerDwell)
	p.DwellMins = 5
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 0)
	h.clock.Advance(6 * time.Minute)
	h.engine.RunDueDwellsForTest(context.Background())
	evs := h.geoEvents()
	if len(evs) != 1 || evs[0].Trigger != domain.TriggerDwell || evs[0].UserID != testUser || evs[0].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want one dwell owned by u1 about u2", evs)
	}
}

// After a restart the engine has no state for her device; the timer is owned by
// Harsh, so the device has to be found through his connections.
func TestPeerDwellAfterRestart(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	ctx := context.Background()
	p := h.place("p1", "Grocery", 120, domain.TriggerDwell)
	p.DwellMins = 5
	p.WatchUserIDs = []string{peerUser}
	if _, err := h.store.UpdatePlace(ctx, p); err != nil {
		t.Fatalf("watch: %v", err)
	}

	h.peerFix(inside(), 0)
	h.engine.Forget(peerDevice) // the restart
	h.clock.Advance(6 * time.Minute)
	if _, err := h.store.TouchLastPoint(ctx, peerDevice, inside(), h.clock.Now(), 0, 80); err != nil {
		t.Fatalf("touch: %v", err)
	}
	h.engine.RunDueDwellsForTest(ctx)
	evs := h.geoEvents()
	if len(evs) != 1 || evs[0].Trigger != domain.TriggerDwell || evs[0].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want one dwell about u2", evs)
	}
}

// A connected, sharing peer is still not evaluated against fences that do not
// watch her.
func TestUnwatchedPeerDoesNotFire(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	h.place("p1", "Grocery", 120, domain.TriggerArrive)

	h.peerFix(inside(), 0)
	want(t, h.triggers())
}

// A note can watch her without the place doing so; marking it done stops it.
func TestNoteWithWatchUserFires(t *testing.T) {
	h := newHarness(t, baseConfig())
	h.withPeer(true)
	h.place("p1", "Grocery", 120, domain.TriggerPassby)
	note, err := h.store.CreateNote(context.Background(), domain.Note{
		UserID: testUser, Text: "buy milk", PlaceID: "p1", Trigger: domain.TriggerPassby,
		WatchUserID: peerUser, NotifyUserIDs: []string{testUser, peerUser},
	})
	if err != nil {
		t.Fatalf("create note: %v", err)
	}

	h.peerFix(outside(), 10)
	h.clock.Advance(time.Second)
	h.peerFix(inside(), 10)
	evs := h.geoEvents()
	if len(evs) != 1 || evs[0].Trigger != domain.TriggerPassby || evs[0].SubjectUserID != peerUser {
		t.Fatalf("events = %+v, want one passby about u2", evs)
	}

	// Done: the place no longer watches her, so leaving is forgotten quietly
	// and coming back is not evaluated.
	note.Done = true
	if _, err := h.store.UpdateNote(context.Background(), note); err != nil {
		t.Fatalf("update note: %v", err)
	}
	h.clock.Advance(time.Second)
	h.peerFix(outside(), 10)
	h.clock.Advance(time.Hour) // past the cool-off
	h.peerFix(inside(), 10)
	if evs := h.geoEvents(); len(evs) != 1 {
		t.Fatalf("events after the note was done = %+v, want still one", evs)
	}
}

// A geo event round-trips the new fields over the bus as the client expects.
func TestGeoEventWireNames(t *testing.T) {
	raw, err := json.Marshal(domain.GeoEvent{SubjectUserID: "u2", SubjectName: "Nishtha"})
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	if m["subjectUserId"] != "u2" || m["subjectName"] != "Nishtha" {
		t.Fatalf("wire = %s", raw)
	}
}
