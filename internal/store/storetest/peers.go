package storetest

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/connect"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/geofence"
	"github.com/HarshSingh21/locnot/internal/store"
)

// These cases cover what the polygons-and-peers release asks of a store beyond
// plain CRUD: rings that come back bit-for-bit, containment that agrees with
// the edges the map draws, and the reads and writes the geofence engine and
// the connection service make on someone else's fences.

// testPolygonExactVertices: a ring drawn on the map arrives with full float64
// precision, and every later rewrite of the place (a rename, a watcher pruned
// on disconnect) writes back what it read. Any rounding on the way out would
// quietly move the fence on every such write.
func testPolygonExactVertices(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")

	ring := []domain.Point{
		{Lat: 51.501364291867325, Lon: -0.14189492345678912},
		{Lat: 51.50153879012345, Lon: -0.1408267890123457},
		{Lat: 51.50079911223344, Lon: -0.1406543210987654},
		{Lat: 51.500712345678906, Lon: -0.14178901234567891},
	}
	created, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_exact", UserID: "u1", Name: "Palace", Shape: domain.ShapePolygon, Polygon: ring,
		Center: domain.Point{Lat: 51.50110, Lon: -0.14130}, RadiusM: 60,
		Triggers: []domain.Trigger{domain.TriggerArrive},
	})
	if err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	sameRing(t, "create", created.Polygon, ring)

	got, err := st.GetPlace(ctx, "u1", "p_exact")
	if err != nil {
		t.Fatalf("GetPlace: %v", err)
	}
	sameRing(t, "get", got.Polygon, ring)

	// Rename only: the ring read back is written back unchanged, repeatedly.
	for i := 0; i < 3; i++ {
		got.Name = "Palace " + string(rune('A'+i))
		if got, err = st.UpdatePlace(ctx, got); err != nil {
			t.Fatalf("UpdatePlace(rename %d): %v", i, err)
		}
	}
	sameRing(t, "after renames", got.Polygon, ring)

	list, err := st.ListPlaces(ctx, "u1")
	if err != nil || len(list) != 1 {
		t.Fatalf("ListPlaces = %v, %v", list, err)
	}
	sameRing(t, "list", list[0].Polygon, ring)
}

func sameRing(t *testing.T, label string, got, want []domain.Point) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d vertices, want %d", label, len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%s: vertex %d = %v, want exactly %v", label, i, got[i], want[i])
		}
	}
}

// testPolygonEdges: a fix exactly on the ring counts as inside (ST_Covers, not
// ST_Contains), on every edge — including the equator-side edge that runs along
// a parallel. The map draws that edge straight along the parallel, so that is
// the edge the user meant, not the great circle between its ends.
func testPolygonEdges(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPolygon(t, st, "u1", "p_l", "Grocery", lShape())

	// An 8 km wide fence at 60°N, within the API's 5 km bounding radius: the
	// great circle between its two southern corners bows ~2 m north of the edge
	// the map draws.
	wide := []domain.Point{
		{Lat: 60.00, Lon: 10.00}, {Lat: 60.00, Lon: 10.144}, {Lat: 60.02, Lon: 10.144}, {Lat: 60.02, Lon: 10.00},
	}
	if _, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_wide", UserID: "u1", Name: "Fjord", Shape: domain.ShapePolygon, Polygon: wide,
		Center: domain.Point{Lat: 60.01, Lon: 10.072}, RadiusM: 4300,
		Triggers: []domain.Trigger{domain.TriggerArrive},
	}); err != nil {
		t.Fatalf("CreatePlace(wide): %v", err)
	}

	cases := []struct {
		label string
		pt    domain.Point
		want  string // the place id expected, "" for none
	}{
		{"on the south (equator-side) edge", domain.Point{Lat: 12.9600, Lon: 77.6385}, "p_l"},
		{"on the west edge", domain.Point{Lat: 12.9603, Lon: 77.6380}, "p_l"},
		{"on the north edge of the upright", domain.Point{Lat: 12.9610, Lon: 77.6382}, "p_l"},
		{"on the notch's inner floor", domain.Point{Lat: 12.9605, Lon: 77.6388}, "p_l"},
		{"on the notch's inner wall", domain.Point{Lat: 12.9608, Lon: 77.6385}, "p_l"},
		{"on a vertex", domain.Point{Lat: 12.9610, Lon: 77.6380}, "p_l"},
		{"on the concave corner", domain.Point{Lat: 12.9605, Lon: 77.6385}, "p_l"},
		{"just past the south edge", domain.Point{Lat: 12.95999, Lon: 77.6385}, ""},
		{"just inside the notch", domain.Point{Lat: 12.96051, Lon: 77.63851}, ""},
		{"1 m inside the wide fence's south edge", domain.Point{Lat: 60.000009, Lon: 10.072}, "p_wide"},
		{"on the wide fence's south edge", domain.Point{Lat: 60.00, Lon: 10.072}, "p_wide"},
		{"1 m south of the wide fence", domain.Point{Lat: 59.999991, Lon: 10.072}, ""},
	}
	for _, c := range cases {
		inside, err := st.PlacesContaining(ctx, "u1", c.pt)
		if err != nil {
			t.Fatalf("PlacesContaining(%s): %v", c.label, err)
		}
		got := ""
		if len(inside) == 1 {
			got = inside[0].ID
		}
		if len(inside) > 1 || got != c.want {
			t.Errorf("%s: containing = %v, want [%s]", c.label, names(inside), c.want)
		}
	}
}

// testCircleMoves: a circle is judged by where it is now. Moving it or
// shrinking it through UpdatePlace changes the answer on the next query.
func testCircleMoves(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	p := mustPlace(t, st, "u1", "p_c", "Cafe", 12.9611, 77.6387, 100)

	// One metre of latitude is ~1/111195 degrees.
	const m = 1.0 / 111195.0
	check := func(label string, pt domain.Point, want bool) {
		t.Helper()
		inside, err := st.PlacesContaining(ctx, "u1", pt)
		if err != nil {
			t.Fatalf("PlacesContaining(%s): %v", label, err)
		}
		if got := len(inside) == 1 && inside[0].ID == "p_c"; got != want {
			t.Errorf("%s: inside = %v, want %v", label, got, want)
		}
	}
	check("95 m north", domain.Point{Lat: 12.9611 + 95*m, Lon: 77.6387}, true)
	check("105 m north", domain.Point{Lat: 12.9611 + 105*m, Lon: 77.6387}, false)

	p.RadiusM = 50
	if _, err := st.UpdatePlace(ctx, p); err != nil {
		t.Fatalf("UpdatePlace(shrink): %v", err)
	}
	check("95 m north after shrink", domain.Point{Lat: 12.9611 + 95*m, Lon: 77.6387}, false)

	p.Center = domain.Point{Lat: 12.9711, Lon: 77.6387}
	if _, err := st.UpdatePlace(ctx, p); err != nil {
		t.Fatalf("UpdatePlace(move): %v", err)
	}
	check("old centre after move", domain.Point{Lat: 12.9611, Lon: 77.6387}, false)
	check("new centre after move", domain.Point{Lat: 12.9711, Lon: 77.6387}, true)

	// Circle → polygon on the same row. Center and RadiusM become the ring's
	// centroid and bounding radius, as the API computes them.
	poly := p
	poly.Shape = domain.ShapePolygon
	poly.Polygon = lShape()
	poly.Center = domain.Point{Lat: 12.9605, Lon: 77.6385}
	poly.RadiusM = 80
	if _, err := st.UpdatePlace(ctx, poly); err != nil {
		t.Fatalf("UpdatePlace(circle→polygon): %v", err)
	}
	check("old circle centre once it is a polygon elsewhere", domain.Point{Lat: 12.9711, Lon: 77.6387}, false)
	check("inside the ring", domain.Point{Lat: 12.9608, Lon: 77.6382}, true)
}

// mustLive connects a and b, both sharing.
func mustLive(t *testing.T, st store.Store, a, b string) {
	t.Helper()
	for _, c := range []domain.Connection{
		{UserID: a, PeerID: b, PeerName: b, Status: domain.ConnectionAccepted, Sharing: true},
		{UserID: b, PeerID: a, PeerName: a, Status: domain.ConnectionAccepted, Sharing: true},
	} {
		if _, err := st.UpsertConnection(ctxFor(t), c); err != nil {
			t.Fatalf("UpsertConnection(%s→%s): %v", c.UserID, c.PeerID, err)
		}
	}
}

// testPeerWatchCleanup runs the real connection service's Remove over the
// store: watchers and recipients are pruned, and nothing else on those rows —
// least of all a polygon's ring — moves.
func testPeerWatchCleanup(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	for _, u := range []string{"u1", "u2", "u3"} {
		mustUser(t, st, u)
	}
	mustLive(t, st, "u1", "u2")
	mustLive(t, st, "u1", "u3")

	poly, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_poly", UserID: "u1", Name: "School", Shape: domain.ShapePolygon, Polygon: lShape(),
		Center: domain.Point{Lat: 12.9605, Lon: 77.6385}, RadiusM: 80,
		Triggers: []domain.Trigger{domain.TriggerArrive}, WatchUserIDs: []string{"u2", "u3"},
	})
	if err != nil {
		t.Fatalf("CreatePlace(poly): %v", err)
	}
	circle, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_circle", UserID: "u1", Name: "Gym", Center: domain.Point{Lat: 12.99, Lon: 77.70}, RadiusM: 100,
		Triggers: []domain.Trigger{domain.TriggerArrive}, WatchUserIDs: []string{"u2"},
	})
	if err != nil {
		t.Fatalf("CreatePlace(circle): %v", err)
	}
	both, err := st.CreateNote(ctx, domain.Note{UserID: "u1", Text: "both", PlaceID: poly.ID,
		Trigger: domain.TriggerArrive, NotifyUserIDs: []string{"u1", "u2"}})
	if err != nil {
		t.Fatalf("CreateNote(both): %v", err)
	}
	onlyPeer, err := st.CreateNote(ctx, domain.Note{UserID: "u1", Text: "only u2", PlaceID: circle.ID,
		Trigger: domain.TriggerArrive, NotifyUserIDs: []string{"u2"}})
	if err != nil {
		t.Fatalf("CreateNote(only peer): %v", err)
	}
	watching, err := st.CreateNote(ctx, domain.Note{UserID: "u1", Text: "when u2 passes", PlaceID: poly.ID,
		Trigger: domain.TriggerPassby, WatchUserID: "u2"})
	if err != nil {
		t.Fatalf("CreateNote(watching): %v", err)
	}

	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	if err := connect.New(st, b, nil).Remove(ctx, "u1", "u2"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	if _, err := st.GetConnection(ctx, "u2", "u1"); err == nil {
		t.Error("u2's side of the connection survived Remove")
	}
	gotPoly, err := st.GetPlace(ctx, "u1", poly.ID)
	if err != nil {
		t.Fatalf("GetPlace(poly): %v", err)
	}
	if len(gotPoly.WatchUserIDs) != 1 || gotPoly.WatchUserIDs[0] != "u3" {
		t.Errorf("poly watchUserIds = %v, want [u3]", gotPoly.WatchUserIDs)
	}
	sameRing(t, "poly after prune", gotPoly.Polygon, lShape())
	if gotPoly.Shape != domain.ShapePolygon {
		t.Errorf("poly shape after prune = %q", gotPoly.Shape)
	}
	gotCircle, err := st.GetPlace(ctx, "u1", circle.ID)
	if err != nil {
		t.Fatalf("GetPlace(circle): %v", err)
	}
	if gotCircle.WatchUserIDs == nil || len(gotCircle.WatchUserIDs) != 0 {
		t.Errorf("circle watchUserIds = %#v, want empty non-nil", gotCircle.WatchUserIDs)
	}
	if raw, _ := json.Marshal(gotCircle); !jsonHas(raw, `"watchUserIds":[]`) {
		t.Errorf("pruned circle JSON: %s", raw)
	}

	for _, c := range []struct {
		id         string
		wantNotify []string
		wantWatch  string
	}{
		{both.ID, []string{"u1"}, ""},
		{onlyPeer.ID, []string{"u2"}, ""}, // emptying it would mean "notify the owner"
		{watching.ID, []string{}, "u2"},   // never rewritten into "when I pass"
	} {
		n, err := st.GetNote(ctx, "u1", c.id)
		if err != nil {
			t.Fatalf("GetNote(%s): %v", c.id, err)
		}
		if !equalStrings(n.NotifyUserIDs, c.wantNotify) || n.WatchUserID != c.wantWatch {
			t.Errorf("note %q: notify=%#v watch=%q, want %v %q", n.Text, n.NotifyUserIDs, n.WatchUserID, c.wantNotify, c.wantWatch)
		}
	}
}

func jsonHas(raw []byte, frag string) bool {
	return len(raw) > 0 && contains(string(raw), frag)
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if a == nil || len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// testPeerGeofence runs the geofence engine itself over the store: u1's fences
// are evaluated against u2's fixes when, and only when, a fence (or an open
// note on it) watches u2 and u2 shares live with u1.
func testPeerGeofence(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustUser(t, st, "u2")
	mustDevice(t, st, "u2", "d2")
	mustLive(t, st, "u1", "u2")

	if _, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_watch", UserID: "u1", Name: "School", Shape: domain.ShapePolygon, Polygon: lShape(),
		Center: domain.Point{Lat: 12.9605, Lon: 77.6385}, RadiusM: 80,
		Triggers: []domain.Trigger{domain.TriggerArrive, domain.TriggerLeave}, WatchUserIDs: []string{"u2"},
	}); err != nil {
		t.Fatalf("CreatePlace(watch): %v", err)
	}
	// Watched only through an open note.
	noted := mustPlace(t, st, "u1", "p_note", "Bakery", 12.9700, 77.6400, 80, domain.TriggerArrive)
	if _, err := st.CreateNote(ctx, domain.Note{UserID: "u1", Text: "bread", PlaceID: noted.ID,
		Trigger: domain.TriggerArrive, WatchUserID: "u2"}); err != nil {
		t.Fatalf("CreateNote(watching): %v", err)
	}
	// Watched only through a done note: must not be evaluated.
	done := mustPlace(t, st, "u1", "p_done", "Bank", 12.9800, 77.6400, 80, domain.TriggerArrive)
	if _, err := st.CreateNote(ctx, domain.Note{UserID: "u1", Text: "paid", PlaceID: done.ID,
		Trigger: domain.TriggerArrive, WatchUserID: "u2", Done: true}); err != nil {
		t.Fatalf("CreateNote(done): %v", err)
	}
	// Not watched at all.
	mustPlace(t, st, "u1", "p_mine", "Office", 12.9900, 77.6400, 80, domain.TriggerArrive)

	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	var (
		mu     sync.Mutex
		events []domain.GeoEvent
	)
	sub, err := b.SubscribePartitioned(bus.GeoAll(), 1, bus.UserKey, func(m bus.Msg) {
		var ev domain.GeoEvent
		if json.Unmarshal(m.Data, &ev) == nil {
			mu.Lock()
			events = append(events, ev)
			mu.Unlock()
		}
	})
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	t.Cleanup(sub.Unsubscribe)

	eng := geofence.New(st, b, gate.NewMemory(), nil, geofence.Config{Partitions: 1, DwellTick: time.Hour})
	ts := time.Now().UTC()
	fix := func(lat, lon float64) {
		t.Helper()
		ts = ts.Add(time.Second)
		if err := eng.Evaluate(ctx, domain.Position{DeviceID: "d2", UserID: "u2",
			RecvTS: ts, DeviceTS: ts, Point: domain.Point{Lat: lat, Lon: lon}}); err != nil {
			t.Fatalf("Evaluate: %v", err)
		}
	}
	fired := func(want int) []domain.GeoEvent {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for {
			mu.Lock()
			n := len(events)
			mu.Unlock()
			if n >= want || time.Now().After(deadline) {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(20 * time.Millisecond) // and nothing more
		mu.Lock()
		defer mu.Unlock()
		return append([]domain.GeoEvent(nil), events...)
	}

	fix(12.9608, 77.6382) // inside the watched L
	fix(12.9700, 77.6400) // the note-watched bakery
	fix(12.9800, 77.6400) // the done-note bank
	fix(12.9900, 77.6400) // the unwatched office
	got := fired(3)

	var seen []string
	for _, ev := range got {
		if ev.UserID != "u1" || ev.Subject() != "u2" {
			t.Errorf("event %s/%s: owner=%s subject=%s, want u1/u2", ev.PlaceID, ev.Trigger, ev.UserID, ev.Subject())
		}
		seen = append(seen, ev.PlaceID+":"+string(ev.Trigger))
	}
	want := []string{"p_watch:arrive", "p_watch:leave", "p_note:arrive"}
	if !equalStrings(seen, want) {
		t.Errorf("peer events = %v, want %v", seen, want)
	}
}
