package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/config"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// Fence scenarios: drawing, editing and crossing geofences, on both stores,
// over the real API and sockets. Harsh owns the fences; Nishtha is connected
// to him and must never hear about his own crossings.

// fenceQuiet is how long a "nothing else arrives" assertion listens. The
// engine and the notify worker run in-process, so anything that was going to
// arrive does so within a few milliseconds.
const fenceQuiet = 400 * time.Millisecond

func countGeo(evs []domain.GeoEvent, placeID string, trigger domain.Trigger) int {
	n := 0
	for _, ev := range evs {
		if ev.PlaceID == placeID && ev.Trigger == trigger {
			n++
		}
	}
	return n
}

// twoPeople is the reference set-up: Harsh and Nishtha, connected, both
// sharing live, both with a socket open.
func twoPeople(s *fenceStack) (harsh, nishtha fencePerson, hs, ns *fenceSocket) {
	harsh = s.person("Harsh")
	nishtha = s.person("Nishtha")
	s.connect(harsh, nishtha)
	return harsh, nishtha, s.socket(harsh), s.socket(nishtha)
}

// ---------------------------------------------------------------- creating fences

// A circle fence fires arrive and leave for its owner's own phone; the
// connected person hears nothing about it.
func TestFenceScenarioCircleArriveLeaveIsTheOwnersAlone(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, ns := twoPeople(s)
		gym := s.createPlace(harsh, circleBody("Gym", fenceOrigin, 60, "arrive", "leave"))
		id := gym["id"].(string)
		if gym["shape"] != "circle" || len(ringOf(t, gym)) != 0 {
			t.Fatalf("circle = %v", gym)
		}

		s.at(harsh, fenceOffset(fenceOrigin, 0, 400))
		s.at(harsh, fenceOrigin)
		ev := hs.geo(id, domain.TriggerArrive)
		if ev.UserID != harsh.userID || ev.SubjectUserID != harsh.userID || ev.SubjectName != "Harsh" || ev.DeviceID != harsh.deviceID {
			t.Errorf("arrive = %+v, want Harsh's own arrival", ev)
		}
		if msg := hs.reminder(id); msg.UserID != harsh.userID || msg.Title == "" || msg.Kind != "note" {
			t.Errorf("Harsh's toast = %+v", msg)
		}

		s.at(harsh, fenceOffset(fenceOrigin, 0, 400))
		hs.geo(id, domain.TriggerLeave)

		ns.none(fenceQuiet, "about Harsh's own fence", hub.FrameGeo, hub.FrameNotify)
	})
}

// Polygon rules on create: 3–200 vertices, no self-intersection, an open ring
// (a closed one is accepted and stored open), and the server — not the client
// — decides the centre and radius.
func TestFenceScenarioPolygonCreateRules(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh := s.person("Harsh")
		c := fenceOrigin

		ring := boxRing(c, 50, 50)
		closed := append(append([]map[string]float64{}, ring...), ring[0])
		body := polygonBody("Grocery", closed, "arrive")
		// A client that sends its own (wrong) centre and radius is overruled.
		body["center"] = map[string]float64{"lat": 13.5, "lon": 78.5}
		body["radiusM"] = 20
		p := s.createPlace(harsh, body)
		if p["shape"] != "polygon" || len(ringOf(t, p)) != 4 {
			t.Fatalf("closed ring stored as %v with %d vertices, want an open 4-ring", p["shape"], len(ringOf(t, p)))
		}
		center := p["center"].(map[string]any)
		if d := geo.DistanceM(center["lat"].(float64), center["lon"].(float64), c.Lat, c.Lon); d > 0.5 {
			t.Errorf("centroid is %.2f m from the box centre", d)
		}
		// Half-diagonal of a 100 m square, rounded up.
		if r := p["radiusM"].(float64); r < 70 || r > 72 {
			t.Errorf("radiusM = %v, want ⌈50·√2⌉ = 71", r)
		}
		got := placeOf(t, s.call(harsh.token, http.MethodGet, "/api/v1/places/"+p["id"].(string), nil, http.StatusOK))
		if got["radiusM"] != p["radiusM"] || len(ringOf(t, got)) != 4 {
			t.Errorf("read back %v, created %v", got, p)
		}

		// The smallest and the largest rings the editor can produce.
		tri := boxRing(fenceOffset(c, 90, 2000), 40, 40)[:3]
		if p := s.createPlace(harsh, polygonBody("Triangle", tri)); len(ringOf(t, p)) != 3 {
			t.Errorf("triangle has %d vertices", len(ringOf(t, p)))
		}
		big := freehandRing(fenceOffset(c, 180, 2000), 150, 200)
		if p := s.createPlace(harsh, polygonBody("Park", big)); len(ringOf(t, p)) != 200 {
			t.Errorf("200-vertex ring stored with %d vertices", len(ringOf(t, p)))
		}

		bowTie := []map[string]float64{ring[0], ring[2], ring[1], ring[3]}
		tooMany := freehandRing(c, 150, 201)
		cases := []struct {
			name string
			ring []map[string]float64
		}{
			{"self-intersecting bow tie", bowTie},
			{"two vertices", ring[:2]},
			{"201 vertices", tooMany},
			{"repeated vertex", []map[string]float64{ring[0], ring[1], ring[1], ring[2]}},
			{"all on one line", []map[string]float64{ring[0], ring[1],
				{"lat": ring[0]["lat"], "lon": 2*ring[1]["lon"] - ring[0]["lon"]}}},
			{"wider than 5 km from its centre", boxRing(c, 4000, 4000)},
		}
		for _, tc := range cases {
			if status, code := s.fail(harsh.token, http.MethodPost, "/api/v1/places", polygonBody("X", tc.ring)); status != http.StatusBadRequest || code != "invalid_polygon" {
				t.Errorf("%s: = %d %q, want 400 invalid_polygon", tc.name, status, code)
			}
		}
		// None of the rejected rings was stored.
		places := s.call(harsh.token, http.MethodGet, "/api/v1/places", nil, http.StatusOK)["places"].([]any)
		if len(places) != 3 {
			t.Errorf("%d places stored, want 3", len(places))
		}
	})
}

// A freehand shape — dozens of vertices, a wobbly outline — is an ordinary
// fence: entering it arrives, leaving it leaves.
func TestFenceScenarioFreehandPolygonFires(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, ns := twoPeople(s)
		for _, n := range []int{60, 200} {
			c := fenceOffset(fenceOrigin, 90, float64(n)*30)
			p := s.createPlace(harsh, polygonBody("Freehand", freehandRing(c, 90, n), "arrive", "leave"))
			id := p["id"].(string)
			if len(ringOf(t, p)) != n {
				t.Fatalf("freehand ring stored with %d vertices, want %d", len(ringOf(t, p)), n)
			}
			s.at(harsh, fenceOffset(c, 200, 600))
			s.at(harsh, fenceOffset(c, 30, 40))
			hs.geo(id, domain.TriggerArrive)
			s.at(harsh, fenceOffset(c, 200, 600))
			hs.geo(id, domain.TriggerLeave)
		}
		ns.none(fenceQuiet, "about Harsh's freehand fences", hub.FrameGeo)
	})
}

// On-edge counts as inside, on both stores: a fix exactly on a polygon's edge
// or vertex arrives, and a circle is judged by haversine distance.
func TestFenceScenarioOnTheEdgeIsInside(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh := s.person("Harsh")
		hs := s.socket(harsh)
		away := fenceOffset(fenceOrigin, 270, 5000)

		// Polygon: the midpoint of the south edge, then a vertex.
		for i, onEdge := range []func(r []map[string]float64) domain.Point{
			func(r []map[string]float64) domain.Point {
				return domain.Point{Lat: r[0]["lat"], Lon: (r[0]["lon"] + r[1]["lon"]) / 2}
			},
			func(r []map[string]float64) domain.Point { return domain.Point{Lat: r[2]["lat"], Lon: r[2]["lon"]} },
		} {
			c := fenceOffset(fenceOrigin, 0, float64(i+1)*1000)
			ring := boxRing(c, 50, 50)
			id := s.createPlace(harsh, polygonBody("Edge", ring, "arrive"))["id"].(string)
			s.at(harsh, away)
			s.at(harsh, onEdge(ring))
			hs.geo(id, domain.TriggerArrive)
		}

		// Circle: haversine ≤ radius is inside, in every direction, and a fix
		// just beyond it is outside — the same answer the engine's own
		// hysteresis and restart checks give.
		for i, bearing := range []float64{0, 90, 180, 270} {
			c := fenceOffset(fenceOrigin, 180, float64(i+1)*4000)
			id := s.createPlace(harsh, circleBody("Ring", c, 1000, "arrive"))["id"].(string)
			s.at(harsh, away)
			s.at(harsh, fenceOffset(c, bearing, 1004))
			for _, ev := range fenceGeoEvents(hs.drain(fenceQuiet)) {
				if ev.PlaceID == id {
					t.Fatalf("bearing %v: a fix 4 m outside a 1000 m circle arrived", bearing)
				}
			}
			s.at(harsh, fenceOffset(c, bearing, 999))
			hs.geo(id, domain.TriggerArrive)
		}
	})
}

// ---------------------------------------------------------------- editing fences

// Moving, reshaping and resizing a fence is a PATCH of any subset of its
// geometry, and the engine judges the very next fix against the new geometry:
// a phone the fence moved away from gets a normal leave, one it moved onto
// arrives, and an edit that does not change the geometry changes nothing.
func TestFenceScenarioPatchReevaluatesOnTheNextFix(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, ns := twoPeople(s)
		home := fenceOrigin
		elsewhere := fenceOffset(home, 90, 800)

		p := s.createPlace(harsh, polygonBody("Grocery", boxRing(home, 50, 50), "arrive", "leave"))
		id := p["id"].(string)
		s.at(harsh, home)
		hs.geo(id, domain.TriggerArrive)

		// 1. Move the ring (a whole new polygon) away from him.
		moved := s.patchPlace(harsh, id, map[string]any{"polygon": boxRing(elsewhere, 50, 50)})
		if c := moved["center"].(map[string]any); geo.DistanceM(c["lat"].(float64), c["lon"].(float64), elsewhere.Lat, elsewhere.Lon) > 0.5 {
			t.Fatalf("centroid not recomputed after the move: %v", c)
		}
		s.at(harsh, home)
		hs.geo(id, domain.TriggerLeave)

		// 2. Drag it back by its body: only the centre is sent, the ring moves
		// rigidly with it, and he is inside again.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		back := s.patchPlace(harsh, id, map[string]any{"center": map[string]float64{"lat": home.Lat, "lon": home.Lon}})
		if len(ringOf(t, back)) != 4 {
			t.Fatalf("ring lost on a centre-only move: %v", back)
		}
		s.at(harsh, home)
		hs.geo(id, domain.TriggerArrive)

		// 3. An edit that leaves the geometry alone is not a crossing.
		s.patchPlace(harsh, id, map[string]any{"name": "Corner shop", "tags": []string{"food"}})
		s.at(harsh, home)
		// 4. Reshape it into a circle around him: still inside, nothing fires.
		s.patchPlace(harsh, id, map[string]any{"shape": "circle", "radiusM": 40})
		s.at(harsh, home)
		for _, ev := range fenceGeoEvents(hs.drain(fenceQuiet)) {
			if ev.PlaceID == id {
				t.Fatalf("an edit that kept him inside fired %s", ev.Trigger)
			}
		}

		// 5. Move the circle 300 m east: he left it.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.patchPlace(harsh, id, map[string]any{"center": map[string]float64{"lat": fenceOffset(home, 90, 300).Lat, "lon": fenceOffset(home, 90, 300).Lon}})
		s.at(harsh, home)
		hs.geo(id, domain.TriggerLeave)

		// 6. Resize it until it covers him again: he arrives.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.patchPlace(harsh, id, map[string]any{"radiusM": 400})
		s.at(harsh, home)
		hs.geo(id, domain.TriggerArrive)

		// 7. A rejected edit changes nothing — not the fence, not his state.
		bowTie := boxRing(home, 50, 50)
		bowTie[1], bowTie[2] = bowTie[2], bowTie[1]
		if status, code := s.fail(harsh.token, http.MethodPatch, "/api/v1/places/"+id,
			map[string]any{"shape": "polygon", "polygon": bowTie}); status != http.StatusBadRequest || code != "invalid_polygon" {
			t.Fatalf("bow-tie patch = %d %q", status, code)
		}
		after := placeOf(t, s.call(harsh.token, http.MethodGet, "/api/v1/places/"+id, nil, http.StatusOK))
		if after["shape"] != "circle" || after["radiusM"].(float64) != 400 {
			t.Fatalf("rejected patch altered the fence: %v", after)
		}
		s.at(harsh, home)
		for _, ev := range fenceGeoEvents(hs.drain(fenceQuiet)) {
			if ev.PlaceID == id {
				t.Fatalf("a rejected patch fired %s", ev.Trigger)
			}
		}

		ns.none(fenceQuiet, "about Harsh editing his own fence", hub.FrameGeo, hub.FrameNotify)
	})
}

// ---------------------------------------------------------------- the engine's guards

// Leave hysteresis: a settled visitor only leaves once a fix lands
// LURA_LEAVE_MARGIN_M beyond the edge, widened by that fix's accuracy, but
// never by more than the cap.
func TestFenceScenarioLeaveNeedsTheMargin(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, _ := twoPeople(s)
		c := fenceOrigin
		id := s.createPlace(harsh, circleBody("Office", c, 50, "arrive", "leave"))["id"].(string)
		out := func(beyondM, acc float64) {
			p := fenceOffset(c, 90, 50+beyondM)
			s.fix(harsh, fenceFix{lat: p.Lat, lon: p.Lon, speed: 0.5, acc: acc})
		}
		noLeave := func(why string) {
			t.Helper()
			if n := countGeo(fenceGeoEvents(hs.drain(fenceQuiet)), id, domain.TriggerLeave); n != 0 {
				t.Fatalf("%s: %d leave(s)", why, n)
			}
		}

		s.at(harsh, c)
		hs.geo(id, domain.TriggerArrive)

		out(10, 5)
		out(18, 5)
		noLeave("within the 20 m margin")
		out(35, 40)
		noLeave("35 m out with ±40 m accuracy")
		out(45, 40)
		hs.geo(id, domain.TriggerLeave)

		// The accuracy cap: ±500 m does not keep him inside 60 m out.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.at(harsh, c)
		hs.geo(id, domain.TriggerArrive)
		out(60, 500)
		hs.geo(id, domain.TriggerLeave)
	})

	// The margin is the operator's to set.
	forEachFenceStore(t, func(c *config.Config) { c.LeaveMarginM = 60 }, func(t *testing.T, s *fenceStack) {
		harsh := s.person("Harsh")
		hs := s.socket(harsh)
		c := fenceOrigin
		id := s.createPlace(harsh, circleBody("Office", c, 50, "arrive", "leave"))["id"].(string)
		s.at(harsh, c)
		hs.geo(id, domain.TriggerArrive)
		p := fenceOffset(c, 0, 50+45)
		s.at(harsh, p)
		if n := countGeo(fenceGeoEvents(hs.drain(fenceQuiet)), id, domain.TriggerLeave); n != 0 {
			t.Fatalf("45 m out with a 60 m margin left")
		}
		s.at(harsh, fenceOffset(c, 0, 50+70))
		hs.geo(id, domain.TriggerLeave)
	})
}

// A phone standing at the edge with GPS noise produces one arrival and no
// leave, not a stream of them.
func TestFenceScenarioNoFlappingAtTheEdge(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, _ := twoPeople(s)
		c := fenceOrigin
		circle := s.createPlace(harsh, circleBody("Cafe", c, 60, "arrive", "leave"))["id"].(string)
		poly := s.createPlace(harsh, polygonBody("Kiosk", boxRing(c, 60, 60), "arrive", "leave"))["id"].(string)

		s.at(harsh, fenceOffset(c, 90, 400))
		// ±10 m of noise around the circle's edge (and inside the box's).
		for i := 0; i < 8; i++ {
			d := 52.0
			if i%2 == 1 {
				d = 70
			}
			s.at(harsh, fenceOffset(c, 90, d))
		}
		evs := fenceGeoEvents(hs.drain(fenceQuiet))
		for _, id := range []string{circle, poly} {
			if n := countGeo(evs, id, domain.TriggerArrive); n != 1 {
				t.Errorf("%s: %d arrivals while jittering at the edge, want 1", id, n)
			}
			if n := countGeo(evs, id, domain.TriggerLeave); n != 0 {
				t.Errorf("%s: %d leaves while jittering at the edge, want 0", id, n)
			}
		}

		s.at(harsh, fenceOffset(c, 90, 400))
		evs = fenceGeoEvents(hs.drain(fenceQuiet))
		for _, id := range []string{circle, poly} {
			if n := countGeo(evs, id, domain.TriggerLeave); n != 1 {
				t.Errorf("%s: %d leaves on walking away, want 1", id, n)
			}
		}
	})
}

// Driving past a shop with no fix inside it is still a pass-by: the path
// between two fixes crossed the fence. It is not an arrival, nor a leave.
func TestFenceScenarioFastPassByBetweenFixes(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, ns := twoPeople(s)
		c := fenceOrigin
		circle := s.createPlace(harsh, circleBody("Pharmacy", c, 20, "passby", "arrive", "leave"))["id"].(string)
		poly := s.createPlace(harsh, polygonBody("Bakery", boxRing(fenceOffset(c, 0, 300), 15, 15), "passby", "arrive", "leave"))["id"].(string)

		for _, line := range []domain.Point{c, fenceOffset(c, 0, 300)} {
			west, east := fenceOffset(line, 270, 30), fenceOffset(line, 90, 30)
			s.fix(harsh, fenceFix{lat: west.Lat, lon: west.Lon, speed: 15})
			// Two device-clock seconds apart: 60 m in ~2 s is 30 m/s, a car.
			time.Sleep(2200 * time.Millisecond)
			s.fix(harsh, fenceFix{lat: east.Lat, lon: east.Lon, speed: 15})
		}
		evs := fenceGeoEvents(hs.drain(fenceQuiet))
		for _, id := range []string{circle, poly} {
			if n := countGeo(evs, id, domain.TriggerPassby); n != 1 {
				t.Errorf("%s: %d pass-bys, want 1 (saw %+v)", id, n, evs)
			}
			if n := countGeo(evs, id, domain.TriggerArrive) + countGeo(evs, id, domain.TriggerLeave); n != 0 {
				t.Errorf("%s: a drive-by announced %d arrive/leave events", id, n)
			}
		}
		ns.none(fenceQuiet, "about Harsh's drive", hub.FrameGeo)
	})
}

// Dwell fires once per visit — not again on every tick while he stays — and a
// new visit is a new dwell. Leaving before it matures cancels it.
func TestFenceScenarioDwellOncePerVisit(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, _ := twoPeople(s)
		c := fenceOrigin
		body := circleBody("Library", c, 60, "dwell")
		body["dwellMins"] = 1
		id := s.createPlace(harsh, body)["id"].(string)
		away := fenceOffset(c, 0, 500)

		// The engine's clock is moved, not slept: a dwell matures at entry
		// (real time) + dwellMins, judged by the engine's clock.

		// 1. A visit cut short never dwells.
		s.at(harsh, away)
		s.at(harsh, c)
		hs.none(fenceQuiet, "before the dwell matured", hub.FrameGeo)
		s.at(harsh, away)
		s.clock.advance(61 * time.Second)
		time.Sleep(4 * s.cfg.DwellTick)
		if n := countGeo(fenceGeoEvents(hs.drain(fenceQuiet)), id, domain.TriggerDwell); n != 0 {
			t.Fatalf("a visit that ended before the dwell matured fired %d dwell(s)", n)
		}

		// 2. A visit that lasts fires once.
		s.clock.advance(-61 * time.Second)
		s.at(harsh, c)
		hs.none(fenceQuiet, "before the dwell matured", hub.FrameGeo)
		s.clock.advance(61 * time.Second)
		hs.geo(id, domain.TriggerDwell)

		// He stays: more fixes, more ticks, well past another dwell period.
		for i := 0; i < 3; i++ {
			s.at(harsh, c)
			s.clock.advance(25 * time.Second)
			time.Sleep(4 * s.cfg.DwellTick)
		}
		if n := countGeo(fenceGeoEvents(hs.drain(fenceQuiet)), id, domain.TriggerDwell); n != 0 {
			t.Fatalf("dwell fired %d more times during one visit", n)
		}

		// 3. A new visit, after the cool-off, dwells again.
		s.at(harsh, away)
		s.at(harsh, c)
		hs.geo(id, domain.TriggerDwell)
	})
}

// Freshness and order: a fix the engine sees as older than its window does not
// fire; a fix queued earlier than one already evaluated cannot rewind the
// visit.
func TestFenceScenarioStaleAndLateFixesDoNotFire(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, _ := twoPeople(s)
		c := fenceOrigin
		id := s.createPlace(harsh, circleBody("Home", c, 60, "arrive", "leave"))["id"].(string)
		away := fenceOffset(c, 0, 500)

		// Freshness: with the engine's clock six minutes ahead every fix is
		// older than the 5-minute window.
		s.at(harsh, away)
		s.clock.advance(6 * time.Minute)
		s.at(harsh, c)
		hs.none(fenceQuiet, "for a stale fix", hub.FrameGeo)
		s.clock.advance(-6 * time.Minute)
		s.at(harsh, c)
		hs.geo(id, domain.TriggerArrive)

		// Order: a fix taken before the last one, uploaded after it, is history
		// only — it does not end the visit.
		s.fix(harsh, fenceFix{lat: away.Lat, lon: away.Lon, speed: 0.5, taken: time.Now().Add(-40 * time.Second)})
		s.at(harsh, c)
		if n := countGeo(fenceGeoEvents(hs.drain(fenceQuiet)), id, domain.TriggerLeave); n != 0 {
			t.Fatalf("an out-of-order fix ended the visit")
		}
		s.at(harsh, away)
		hs.geo(id, domain.TriggerLeave)
	})
}

// Cool-off is per device, per place, per trigger: coming straight back does
// not arrive twice, but his second phone, another fence, and another trigger
// are all independent — and the claim expires.
func TestFenceScenarioCoolOffIsPerDevicePlaceTrigger(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, _, hs, _ := twoPeople(s)
		tablet := s.phone(harsh, "tablet")
		c := fenceOrigin
		grocery := s.createPlace(harsh, circleBody("Grocery", c, 60, "arrive", "leave"))["id"].(string)
		bakery := s.createPlace(harsh, circleBody("Bakery", fenceOffset(c, 90, 1000), 60, "arrive"))["id"].(string)
		away := fenceOffset(c, 0, 500)

		s.at(harsh, away)
		s.at(harsh, c)
		hs.geo(grocery, domain.TriggerArrive)
		s.at(harsh, away)
		hs.geo(grocery, domain.TriggerLeave) // another trigger: not cooled off

		s.at(harsh, c)
		s.at(harsh, away)
		evs := fenceGeoEvents(hs.drain(fenceQuiet))
		if n := countGeo(evs, grocery, domain.TriggerArrive) + countGeo(evs, grocery, domain.TriggerLeave); n != 0 {
			t.Fatalf("a second visit inside the cool-off fired %d events", n)
		}

		// His tablet is another device.
		s.at(tablet, away)
		s.at(tablet, c)
		if ev := hs.geo(grocery, domain.TriggerArrive); ev.DeviceID != tablet.deviceID {
			t.Errorf("arrive from %s, want the tablet", ev.DeviceID)
		}
		// Another fence for the same phone.
		s.at(harsh, fenceOffset(c, 90, 1000))
		hs.geo(bakery, domain.TriggerArrive)

		// The claim expires.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.at(harsh, away)
		s.at(harsh, c)
		if ev := hs.geo(grocery, domain.TriggerArrive); ev.DeviceID != harsh.deviceID {
			t.Errorf("arrive from %s after the cool-off, want the phone", ev.DeviceID)
		}
	})
}
