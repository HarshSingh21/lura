package httpapi_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// Watched people: Harsh puts Nishtha on one of his fences. Her crossing is
// his news alone — a geo event and a kind:"watch" reminder on his sessions,
// nothing on hers — and only while her sharing toward him is on.

// remindersOf lists a person's stored reminders.
func (s *fenceStack) remindersOf(p fencePerson) []map[string]any {
	s.t.Helper()
	raw, _ := s.call(p.token, http.MethodGet, "/api/v1/reminders?status=all", nil, http.StatusOK)["reminders"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		out = append(out, r.(map[string]any))
	}
	return out
}

// watchedGrocery is Harsh's polygon that watches Nishtha.
func watchedGrocery(s *fenceStack, harsh, nishtha fencePerson, c domain.Point) string {
	body := polygonBody("Grocery", boxRing(c, 50, 50), "arrive", "leave")
	body["watchUserIds"] = []string{nishtha.userID}
	p := s.createPlace(harsh, body)
	if w, _ := p["watchUserIds"].([]any); len(w) != 1 || w[0] != nishtha.userID {
		s.t.Fatalf("watchUserIds = %v", p["watchUserIds"])
	}
	return p["id"].(string)
}

// Only accepted connections can be watched: not a stranger, a pending invitee,
// someone removed, or yourself. A paused connection is still a connection.
func TestFenceScenarioWatchOnlyAcceptedConnections(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh := s.person("Harsh")
		nishtha := s.person("Nishtha")
		stranger := s.person("Stranger")
		pending := s.person("Pending")
		removed := s.person("Removed")
		s.connect(harsh, nishtha)
		s.connect(harsh, removed)
		s.call(harsh.token, http.MethodDelete, "/api/v1/people/"+removed.userID, nil, http.StatusNoContent)
		s.call(harsh.token, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": pending.email}, http.StatusCreated)

		ring := boxRing(fenceOrigin, 50, 50)
		id := s.createPlace(harsh, polygonBody("Grocery", ring))["id"].(string)

		for _, who := range []fencePerson{stranger, pending, removed, harsh} {
			body := polygonBody("X", ring)
			body["watchUserIds"] = []string{who.userID}
			if status, code := s.fail(harsh.token, http.MethodPost, "/api/v1/places", body); status != http.StatusBadRequest || code != "not_connected" {
				t.Errorf("create watching %s = %d %q, want 400 not_connected", who.name, status, code)
			}
			if status, code := s.fail(harsh.token, http.MethodPatch, "/api/v1/places/"+id,
				map[string]any{"watchUserIds": []string{nishtha.userID, who.userID}}); status != http.StatusBadRequest || code != "not_connected" {
				t.Errorf("patch watching %s = %d %q, want 400 not_connected", who.name, status, code)
			}
		}
		// The rejected patches did not half-apply.
		if w := placeOf(t, s.call(harsh.token, http.MethodGet, "/api/v1/places/"+id, nil, http.StatusOK))["watchUserIds"].([]any); len(w) != 0 {
			t.Errorf("watchUserIds after rejected patches = %v", w)
		}

		// Nishtha pauses: she is still connected, so Harsh may still list her.
		s.setSharing(nishtha, harsh, false)
		p := s.patchPlace(harsh, id, map[string]any{"watchUserIds": []string{nishtha.userID, nishtha.userID, " "}})
		if w := p["watchUserIds"].([]any); len(w) != 1 || w[0] != nishtha.userID {
			t.Errorf("watchUserIds = %v, want [nishtha] (deduplicated)", w)
		}

		// Nobody else can edit Harsh's fence, not even the person it watches.
		for _, who := range []fencePerson{nishtha, stranger} {
			if status, _ := s.fail(who.token, http.MethodPatch, "/api/v1/places/"+id, map[string]any{"watchUserIds": []string{}}); status != http.StatusNotFound {
				t.Errorf("%s patching Harsh's fence = %d, want 404", who.name, status)
			}
		}
	})
}

// The reference crossing, with no note at all: Nishtha walks into and out of
// Harsh's watched fence. He gets a geo event about her and a watch reminder;
// she gets nothing, and nothing she can read lists his fence.
func TestFenceScenarioWatchedCrossingReachesTheOwnerOnly(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, nishtha, hs, ns := twoPeople(s)
		c := fenceOrigin
		id := watchedGrocery(s, harsh, nishtha, c)
		away := fenceOffset(c, 0, 500)

		s.at(nishtha, away)
		s.at(nishtha, c)
		ev := hs.geo(id, domain.TriggerArrive)
		if ev.UserID != harsh.userID || ev.SubjectUserID != nishtha.userID || ev.SubjectName != "Nishtha" ||
			ev.DeviceID != nishtha.deviceID || ev.PlaceName != "Grocery" {
			t.Errorf("geo event = %+v, want Nishtha arriving at Harsh's Grocery", ev)
		}
		msg := hs.reminder(id)
		if msg.Kind != "watch" || msg.Title != "Nishtha arrived at Grocery" || msg.UserID != harsh.userID ||
			msg.SubjectUserID != nishtha.userID || msg.ID == "" || msg.Status != domain.ReminderPending {
			t.Errorf("Harsh's reminder = %+v, want a pending watch reminder about Nishtha", msg)
		}

		s.at(nishtha, away)
		hs.geo(id, domain.TriggerLeave)
		if msg := hs.reminder(id); msg.Kind != "watch" || msg.Title != "Nishtha left Grocery" {
			t.Errorf("leave reminder = %q / %q", msg.Kind, msg.Title)
		}

		// She is not told.
		ns.none(fenceQuiet, "about being watched", hub.FrameGeo, hub.FrameNotify)
		if r := s.remindersOf(nishtha); len(r) != 0 {
			t.Errorf("Nishtha has %d stored reminders, want 0: %v", len(r), r)
		}
		if r := s.remindersOf(harsh); len(r) != 2 {
			t.Errorf("Harsh has %d stored reminders, want 2", len(r))
		}
		for _, path := range []string{"/api/v1/places", "/api/v1/overview"} {
			for _, raw := range s.call(nishtha.token, http.MethodGet, path, nil, http.StatusOK)["places"].([]any) {
				if raw.(map[string]any)["id"] == id {
					t.Errorf("Nishtha's %s lists Harsh's fence", path)
				}
			}
		}
		if status, _ := s.fail(nishtha.token, http.MethodGet, "/api/v1/places/"+id, nil); status != http.StatusNotFound {
			t.Errorf("Nishtha reading Harsh's fence = %d, want 404", status)
		}
	})
}

// Consent is hers: her pausing stops evaluation at once (no leave for a visit
// in progress, no arrival later), resuming starts it again. His own sharing
// switch does not decide what he may watch of her.
func TestFenceScenarioWatchFollowsThePeersSharing(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, nishtha, hs, ns := twoPeople(s)
		c := fenceOrigin
		id := watchedGrocery(s, harsh, nishtha, c)
		away := fenceOffset(c, 0, 500)

		// Harsh pausing his sharing toward her changes nothing about hers.
		s.setSharing(harsh, nishtha, false)
		s.at(nishtha, away)
		s.at(nishtha, c)
		hs.geo(id, domain.TriggerArrive)

		// She pauses mid-visit: walking out is not announced.
		s.setSharing(nishtha, harsh, false)
		s.at(nishtha, away)
		evs := fenceGeoEvents(hs.drain(fenceQuiet))
		if len(evs) != 0 {
			t.Fatalf("Harsh heard %+v after Nishtha paused", evs)
		}
		// Nor a later visit, cool-off or not.
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.at(nishtha, c)
		s.at(nishtha, away)
		hs.none(fenceQuiet, "while Nishtha's sharing is paused", hub.FrameGeo, hub.FrameNotify)

		// She resumes: the next crossing is his news again.
		s.setSharing(nishtha, harsh, true)
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.at(nishtha, c)
		if ev := hs.geo(id, domain.TriggerArrive); ev.SubjectUserID != nishtha.userID {
			t.Errorf("arrive after resume = %+v", ev)
		}
		ns.none(fenceQuiet, "about being watched", hub.FrameGeo, hub.FrameNotify)
	})
}

// Taking her off the watch list mid-visit forgets her silently; putting her
// back makes her next crossing count. Moving a watched fence off her is a
// normal leave, told to him.
func TestFenceScenarioEditingAWatchedFence(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, nishtha, hs, ns := twoPeople(s)
		c := fenceOrigin
		id := watchedGrocery(s, harsh, nishtha, c)
		away := fenceOffset(c, 0, 500)

		s.at(nishtha, away)
		s.at(nishtha, c)
		hs.geo(id, domain.TriggerArrive)

		s.patchPlace(harsh, id, map[string]any{"watchUserIds": []string{}})
		s.at(nishtha, away)
		if evs := fenceGeoEvents(hs.drain(fenceQuiet)); len(evs) != 0 {
			t.Fatalf("an unwatched peer's departure was announced: %+v", evs)
		}

		s.patchPlace(harsh, id, map[string]any{"watchUserIds": []string{nishtha.userID}})
		s.clock.advance(s.cfg.CoolOff + time.Second)
		s.at(nishtha, c)
		hs.geo(id, domain.TriggerArrive)

		// He drags the fence 800 m east while she stands where she is.
		s.patchPlace(harsh, id, map[string]any{"polygon": boxRing(fenceOffset(c, 90, 800), 50, 50)})
		s.at(nishtha, c)
		if ev := hs.geo(id, domain.TriggerLeave); ev.SubjectUserID != nishtha.userID {
			t.Errorf("leave after the move = %+v", ev)
		}
		if msg := hs.reminder(id); msg.Kind != "watch" || msg.Title != "Nishtha left Grocery" {
			t.Errorf("reminder after the move = %q / %q", msg.Kind, msg.Title)
		}
		ns.none(fenceQuiet, "about Harsh editing his fence", hub.FrameGeo, hub.FrameNotify)
	})
}

// Without a watch, a connected person's crossing of your fence is not your
// business; her own fence at the same spot is hers alone. Watching is
// one-way per fence: they can each watch the other on their own fences.
func TestFenceScenarioWatchIsPerFenceAndOneWay(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, nishtha, hs, ns := twoPeople(s)
		c := fenceOrigin
		away := fenceOffset(c, 0, 500)
		unwatched := s.createPlace(harsh, polygonBody("Harsh's shop", boxRing(c, 50, 50), "arrive"))["id"].(string)
		hers := s.createPlace(nishtha, circleBody("Nishtha's shop", c, 60, "arrive"))["id"].(string)

		s.at(nishtha, away)
		s.at(nishtha, c)
		if ev := ns.geo(hers, domain.TriggerArrive); ev.UserID != nishtha.userID {
			t.Errorf("her own arrival = %+v", ev)
		}
		for _, ev := range fenceGeoEvents(hs.drain(fenceQuiet)) {
			t.Fatalf("Harsh heard about her crossing a fence that does not watch her: %+v", ev)
		}
		_ = unwatched

		// Both watch each other, each on their own fence elsewhere.
		elsewhere := fenceOffset(c, 90, 2000)
		harshWatches := watchedGrocery(s, harsh, nishtha, elsewhere)
		body := circleBody("Office", fenceOffset(elsewhere, 0, 1000), 60, "arrive")
		body["watchUserIds"] = []string{harsh.userID}
		nishthaWatches := s.createPlace(nishtha, body)["id"].(string)

		s.at(nishtha, elsewhere)
		s.at(harsh, fenceOffset(elsewhere, 0, 1000))
		if ev := hs.geo(harshWatches, domain.TriggerArrive); ev.SubjectUserID != nishtha.userID {
			t.Errorf("Harsh's watch = %+v", ev)
		}
		if ev := ns.geo(nishthaWatches, domain.TriggerArrive); ev.SubjectUserID != harsh.userID {
			t.Errorf("Nishtha's watch = %+v", ev)
		}
		for _, ev := range fenceGeoEvents(hs.drain(fenceQuiet)) {
			if ev.PlaceID == nishthaWatches {
				t.Errorf("Harsh was told about Nishtha's fence watching him: %+v", ev)
			}
		}
		for _, ev := range fenceGeoEvents(ns.drain(fenceQuiet)) {
			if ev.PlaceID == harshWatches {
				t.Errorf("Nishtha was told about Harsh's fence watching her: %+v", ev)
			}
		}
	})
}

// Nishtha driving past Harsh's watched shop with no fix inside it is still a
// pass-by for him — the crossing rule covers watched fences too — and still
// nothing for her.
func TestFenceScenarioWatchedPeerFastPassBy(t *testing.T) {
	forEachFenceStore(t, nil, func(t *testing.T, s *fenceStack) {
		harsh, nishtha, hs, ns := twoPeople(s)
		c := fenceOrigin
		body := circleBody("Pharmacy", c, 20, "passby", "arrive", "leave")
		body["watchUserIds"] = []string{nishtha.userID}
		id := s.createPlace(harsh, body)["id"].(string)

		west, east := fenceOffset(c, 270, 30), fenceOffset(c, 90, 30)
		s.fix(nishtha, fenceFix{lat: west.Lat, lon: west.Lon, speed: 15})
		time.Sleep(2200 * time.Millisecond)
		s.fix(nishtha, fenceFix{lat: east.Lat, lon: east.Lon, speed: 15})

		ev := hs.geo(id, domain.TriggerPassby)
		if ev.SubjectUserID != nishtha.userID || ev.UserID != harsh.userID {
			t.Errorf("pass-by = %+v, want Nishtha passing Harsh's fence", ev)
		}
		if msg := hs.reminder(id); msg.Kind != "watch" || msg.Title == "" {
			t.Errorf("pass-by reminder = %+v", msg)
		}
		evs := fenceGeoEvents(hs.drain(fenceQuiet))
		if n := countGeo(evs, id, domain.TriggerArrive) + countGeo(evs, id, domain.TriggerLeave) + countGeo(evs, id, domain.TriggerPassby); n != 0 {
			t.Errorf("one drive-by produced %d more events", n)
		}
		ns.none(fenceQuiet, "about being watched", hub.FrameGeo, hub.FrameNotify)
	})
}
