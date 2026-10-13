package httpapi_test

// Authorization between two signed-in people. Being connected to someone shares
// your live position with them — nothing else. Every attempt by one person to
// read, change, acknowledge or delete what belongs to the other answers like a
// missing id (404) and carries none of the other person's data.

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// harshsPrivateThings is what Harsh owns that Nishtha must never reach.
type harshsPrivateThings struct {
	placeID, noteID, shareID, channelID, reminderID string
}

const (
	secretPlace = "Harsh Secret Spot"
	secretNote  = "pick up the anniversary ring"
)

func (s *authStack) harshsPrivateThings(harsh, nishtha *authUser) harshsPrivateThings {
	s.t.Helper()
	var out harshsPrivateThings
	out.placeID = asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/places", map[string]any{
		"name": secretPlace, "center": map[string]any{"lat": 12.97, "lon": 77.59}, "radiusM": 120,
		"triggers": []string{"arrive"},
	}, http.StatusCreated)["place"])["id"].(string)
	out.noteID = asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/notes", map[string]any{
		"text": secretNote, "placeId": out.placeID, "trigger": "arrive", "autoSuggest": false,
	}, http.StatusCreated)["note"])["id"].(string)
	out.shareID = asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/shares", map[string]any{
		"label": "Mum", "mode": "duration", "durationMins": 60,
	}, http.StatusCreated)["share"])["id"].(string)
	out.channelID = asMap(s.t, s.must(harsh.token, http.MethodPost, "/api/v1/channels", map[string]any{
		"type": "ntfy", "config": map[string]string{"topic": "harsh-private-topic"},
	}, http.StatusCreated)["channel"])["id"].(string)

	// A reminder for Harsh alone: his watched Grocery fires when Nishtha arrives.
	s.harshWatchesNishtha(harsh, nishtha)
	s.arrive(nishtha)
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		list, _ := s.must(harsh.token, http.MethodGet, "/api/v1/reminders?status=pending", nil, http.StatusOK)["reminders"].([]any)
		if len(list) > 0 {
			out.reminderID = asMap(s.t, list[0])["id"].(string)
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if out.reminderID == "" {
		s.t.Fatal("Harsh's watch reminder never arrived")
	}
	// History for his phone, away from his own fences.
	s.pub(harsh, 12.80, 77.40, 0)
	s.pub(harsh, 12.801, 77.401, 1)
	return out
}

// refused asserts a cross-user request is answered like a missing id and
// carries none of the owner's data.
func (s *authStack) refused(t *testing.T, who *authUser, method, path string, body any) {
	t.Helper()
	r := s.call(who.token, method, path, body)
	if r.status != http.StatusNotFound && r.status != http.StatusForbidden {
		t.Errorf("%s: %s %s = %d, want 404/403: %s", who.id.Name, method, path, r.status, r.body)
	}
	for _, leak := range []string{secretPlace, secretNote, "harsh-private-topic", "Mum", "buy milk"} {
		if strings.Contains(string(r.body), leak) {
			t.Errorf("%s: %s %s leaks %q: %s", who.id.Name, method, path, leak, r.body)
		}
	}
}

// Scenario: Nishtha (connected to Harsh) and Mallory (a stranger) try every
// by-id route on Harsh's places, notes, shares, channels, devices, reminders
// and history. All are refused, Harsh's data is untouched afterwards, and their
// own lists and activity feeds never contain it.
func TestAuthScenarioNobodyReachesAnotherPersonsData(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh, nishtha, mal := s.signIn(harshID), s.signIn(nishthaID), s.signIn(mallory)
		h := s.harshsPrivateThings(harsh, nishtha)

		for _, other := range []*authUser{nishtha, mal} {
			s.refused(t, other, http.MethodGet, "/api/v1/places/"+h.placeID, nil)
			s.refused(t, other, http.MethodPatch, "/api/v1/places/"+h.placeID, map[string]any{"name": "pwned"})
			s.refused(t, other, http.MethodPut, "/api/v1/places/"+h.placeID, map[string]any{"name": "pwned"})
			s.refused(t, other, http.MethodDelete, "/api/v1/places/"+h.placeID, nil)
			s.refused(t, other, http.MethodGet, "/api/v1/notes/"+h.noteID, nil)
			s.refused(t, other, http.MethodPatch, "/api/v1/notes/"+h.noteID, map[string]any{"done": true})
			s.refused(t, other, http.MethodDelete, "/api/v1/notes/"+h.noteID, nil)
			s.refused(t, other, http.MethodDelete, "/api/v1/shares/"+h.shareID, nil)
			s.refused(t, other, http.MethodPatch, "/api/v1/channels/"+h.channelID, map[string]any{"enabled": false})
			s.refused(t, other, http.MethodDelete, "/api/v1/channels/"+h.channelID, nil)
			s.refused(t, other, http.MethodGet, "/api/v1/devices/"+harsh.deviceID, nil)
			s.refused(t, other, http.MethodPatch, "/api/v1/devices/"+harsh.deviceID, map[string]any{"name": "pwned"})
			s.refused(t, other, http.MethodDelete, "/api/v1/devices/"+harsh.deviceID, nil)
			s.refused(t, other, http.MethodPost, "/api/v1/devices/"+harsh.deviceID+"/token", nil)
			s.refused(t, other, http.MethodPost, "/api/v1/reminders/"+h.reminderID+"/ack", nil)
			s.refused(t, other, http.MethodGet, "/api/v1/history?deviceId="+harsh.deviceID, nil)
			s.refused(t, other, http.MethodGet, "/api/v1/history/export?deviceId="+harsh.deviceID, nil)

			// Using Harsh's things as references in their own records is refused too.
			if r := s.call(other.token, http.MethodPost, "/api/v1/notes", map[string]any{
				"text": "x", "placeId": h.placeID, "trigger": "arrive", "autoSuggest": false,
			}); r.status < 400 || r.status >= 500 {
				t.Errorf("%s: note on Harsh's place = %d: %s", other.id.Name, r.status, r.body)
			}
			if r := s.call(other.token, http.MethodPost, "/api/v1/shares", map[string]any{
				"label": "x", "mode": "duration", "durationMins": 30, "deviceIds": []string{harsh.deviceID},
			}); r.status < 400 || r.status >= 500 {
				t.Errorf("%s: public share of Harsh's phone = %d: %s", other.id.Name, r.status, r.body)
			}
			if r := s.call(other.token, http.MethodPost, "/api/v1/shares", map[string]any{
				"label": "x", "mode": "arrive", "arrivePlaceId": h.placeID,
			}); r.status < 400 || r.status >= 500 {
				t.Errorf("%s: share ending at Harsh's place = %d: %s", other.id.Name, r.status, r.body)
			}

			// Their own erasure cannot reach Harsh's history.
			s.must(other.token, http.MethodDelete, "/api/v1/history?all=true", nil, http.StatusOK)

			// Their lists and feeds contain nothing of his.
			for _, path := range []string{"/api/v1/places", "/api/v1/notes", "/api/v1/shares", "/api/v1/channels",
				"/api/v1/devices", "/api/v1/reminders?status=all", "/api/v1/activity?from=-2h", "/api/v1/overview",
				"/api/v1/events", "/api/v1/history?from=-2h"} {
				r := s.call(other.token, http.MethodGet, path, nil)
				if r.status != http.StatusOK {
					t.Errorf("%s: GET %s = %d", other.id.Name, path, r.status)
				}
				leaks := []string{secretPlace, secretNote, "harsh-private-topic", h.reminderID, h.shareID, "buy milk"}
				if other == mal {
					// Nishtha sees Harsh's phone live, by design; a stranger does not.
					leaks = append(leaks, harsh.deviceID)
				}
				for _, leak := range leaks {
					if strings.Contains(string(r.body), leak) {
						t.Errorf("%s: GET %s contains Harsh's %q", other.id.Name, path, leak)
					}
				}
			}
		}

		// Harsh's world is exactly as he left it.
		if p := asMap(t, s.must(harsh.token, http.MethodGet, "/api/v1/places/"+h.placeID, nil, http.StatusOK)["place"]); p["name"] != secretPlace {
			t.Errorf("Harsh's place = %v", p)
		}
		if n := asMap(t, s.must(harsh.token, http.MethodGet, "/api/v1/notes/"+h.noteID, nil, http.StatusOK)["note"]); n["done"] == true || n["text"] != secretNote {
			t.Errorf("Harsh's note = %v", n)
		}
		pending, _ := s.must(harsh.token, http.MethodGet, "/api/v1/reminders?status=pending", nil, http.StatusOK)["reminders"].([]any)
		if len(pending) != 1 {
			t.Errorf("Harsh's pending reminders = %v", pending)
		}
		shares, _ := s.must(harsh.token, http.MethodGet, "/api/v1/shares", nil, http.StatusOK)["shares"].([]any)
		if len(shares) != 1 || asMap(t, shares[0])["revokedAt"] != nil {
			t.Errorf("Harsh's shares = %v", shares)
		}
		channels, _ := s.must(harsh.token, http.MethodGet, "/api/v1/channels", nil, http.StatusOK)["channels"].([]any)
		if len(channels) != 1 || asMap(t, channels[0])["enabled"] == false {
			t.Errorf("Harsh's channels = %v", channels)
		}
		dev := asMap(t, s.must(harsh.token, http.MethodGet, "/api/v1/devices/"+harsh.deviceID, nil, http.StatusOK)["device"])
		if dev["name"] != "Harsh's Phone" {
			t.Errorf("Harsh's device = %v", dev)
		}
		s.pub(harsh, 12.972, 77.592, 1) // his phone's token still works
		hist := s.must(harsh.token, http.MethodGet, "/api/v1/history?from=-2h&deviceId="+harsh.deviceID, nil, http.StatusOK)
		if pts, _ := hist["points"].(float64); pts < 2 {
			t.Errorf("Harsh's history lost points: %v", hist["points"])
		}
	})
}

// Scenario: registering a device under an id someone else's phone already has
// must not take that phone over — not its owner, its last position, nor the
// fixes it publishes afterwards.
func TestAuthScenarioADeviceIdCannotBeTakenOver(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh, nishtha := s.signIn(harshID), s.signIn(nishthaID)
		s.pub(harsh, 12.97, 77.59, 0)

		r := s.call(nishtha.token, http.MethodPost, "/api/v1/devices", map[string]any{"id": harsh.deviceID, "name": "Mine now"})
		if r.status != http.StatusConflict {
			t.Errorf("registering Harsh's device id as Nishtha = %d, want 409: %s", r.status, r.body)
		}
		if strings.Contains(string(r.body), "pubToken") {
			t.Errorf("the refused registration handed out a token: %s", r.body)
		}

		dev := asMap(t, s.must(harsh.token, http.MethodGet, "/api/v1/devices/"+harsh.deviceID, nil, http.StatusOK)["device"])
		if dev["name"] != "Harsh's Phone" || dev["userId"] != harsh.id.Sub {
			t.Errorf("Harsh's device after the attempt = %v", dev)
		}
		s.refused(t, nishtha, http.MethodGet, "/api/v1/devices/"+harsh.deviceID, nil)
		s.pub(harsh, 12.971, 77.591, 1)

		// Re-registering one's own id is still an upsert (an app reinstall).
		s.must(harsh.token, http.MethodPost, "/api/v1/devices", map[string]any{"id": harsh.deviceID, "name": "Harsh's Phone"}, http.StatusCreated)
	})
}

// Scenario: People routes about someone you are not connected to are 404, and
// connecting is the only thing that shares anything.
func TestAuthScenarioPeopleRoutesNeedAConnection(t *testing.T) {
	eachAuthBackend(t, func(t *testing.T, b authBackend) {
		s := newAuthStack(t, b, nil)
		harsh, nishtha, mal := s.signIn(harshID), s.signIn(nishthaID), s.signIn(mallory)
		s.connect(harsh, nishtha)

		for _, rt := range [][2]string{
			{http.MethodPatch, "/api/v1/people/" + harsh.id.Sub},
			{http.MethodDelete, "/api/v1/people/" + harsh.id.Sub},
			{http.MethodPost, "/api/v1/people/" + harsh.id.Sub + "/accept"},
		} {
			var body any
			if rt[0] == http.MethodPatch {
				body = map[string]any{"sharing": false}
			}
			r := s.call(mal.token, rt[0], rt[1], body)
			if r.status != http.StatusNotFound {
				t.Errorf("Mallory %s %s = %d, want 404: %s", rt[0], rt[1], r.status, r.body)
			}
		}
		people, _ := s.must(mal.token, http.MethodGet, "/api/v1/people", nil, http.StatusOK)["people"].([]any)
		if len(people) != 0 {
			t.Errorf("Mallory's people = %v", people)
		}
		// Harsh and Nishtha's connection is intact.
		hp, _ := s.must(harsh.token, http.MethodGet, "/api/v1/people", nil, http.StatusOK)["people"].([]any)
		if len(hp) != 1 || asMap(t, hp[0])["peerId"] != nishtha.id.Sub {
			t.Errorf("Harsh's people = %v", hp)
		}
	})
}
