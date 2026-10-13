package httpapi_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
)

// walkThrough has p walk slowly into a fence and out again: an arrive and a
// leave where the fence has them.
func (s *actStack) walkThrough(p actPerson, at domain.Point) {
	s.t.Helper()
	s.pub(p, at.Lat-0.004, at.Lon, 1)
	s.pub(p, at.Lat, at.Lon, 0.4)
	s.pub(p, at.Lat+0.004, at.Lon, 1)
}

func noGeoOrNotify(t *testing.T, frames []hub.Frame, who string) {
	t.Helper()
	for _, f := range frames {
		if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
			t.Errorf("%s's socket carried a %s: %s", who, f.Type, f.Data)
		}
	}
}

// Nishtha moves all day. Harsh sees her only where he was entitled to: the
// fence he watches her on. Not his other fences, not a note that tells only
// her, not her own places — and never her track.
func TestActivityShowsAPeerOnlyAsEntitledEvents(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		s := newActStack(t, be.open(t), actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)

		watched := circle("Grocery", actGrocery, "arrive", "leave")
		watched["watchUserIds"] = []string{nishtha.id}
		s.place(harsh, watched)
		s.place(harsh, circle("Gym", actGym, "arrive", "leave"))
		gym2 := s.place(harsh, circle("Gym2", actGym2, "arrive"))
		s.note(harsh, map[string]any{
			"text": "pick up keys", "placeId": gym2, "trigger": "arrive",
			"watchUserId": nishtha.id, "notifyUserIds": []string{nishtha.id},
		})
		s.place(nishtha, circle("Her Gym", actHerGym, "arrive"))

		harshWS := s.ws(harsh)
		nishthaWS := s.ws(nishtha)

		// A distinctive point of hers outside every fence.
		s.pub(nishtha, 12.95432, 77.61234, 5)
		s.walkThrough(nishtha, actGrocery)
		s.walkThrough(nishtha, actGym)
		s.walkThrough(nishtha, actGym2)
		s.pub(nishtha, actHerGym.Lat-0.004, actHerGym.Lon, 1)
		s.pub(nishtha, actHerGym.Lat, actHerGym.Lon, 0.4)

		s.waitActivity(nishtha, "?from=-1h", func(items []map[string]any) bool {
			return countLines(items, "geo Nishtha arrive Her Gym") == 1 &&
				countLines(items, `reminder note "pick up keys"`) == 1
		})
		s.waitActivity(harsh, "?from=-1h", func(items []map[string]any) bool {
			return countLines(items, "geo Nishtha leave Grocery") == 1
		})
		// Let anything late land before judging what is absent.
		time.Sleep(300 * time.Millisecond)
		mine := s.activity(harsh, "?from=-1h")
		hers := s.activity(nishtha, "?from=-1h")

		if !subsequence(mine, []string{"geo Nishtha arrive Grocery", "geo Nishtha leave Grocery"}) {
			t.Errorf("Harsh's feed lacks Nishtha at the fence he watches:%s", describeItems(mine))
		}
		if n := countLines(mine, "reminder watch"); n != 2 {
			t.Errorf("Harsh has %d watch reminders, want arrive and leave:%s", n, describeItems(mine))
		}
		for _, it := range mine {
			line := itemLine(it)
			switch {
			case it["type"] == "trip" || it["type"] == "stop":
				t.Errorf("Harsh's feed has movement %s (his phone never moved)", line)
			case it["type"] == "geo" && it["placeName"] != "Grocery":
				t.Errorf("Harsh sees a crossing he was not entitled to: %s", line)
			case strings.Contains(line, "pick up keys"):
				t.Errorf("Harsh sees the note that tells only Nishtha: %s", line)
			}
		}
		rawMine, _ := json.Marshal(mine)
		for _, leak := range []string{"12.95432", "77.61234", "Her Gym"} {
			if strings.Contains(string(rawMine), leak) {
				t.Errorf("Harsh's feed carries %q: %s", leak, rawMine)
			}
		}

		// Her feed: her place, the note sent to her, nothing of his fences.
		if countLines(hers, "geo Nishtha arrive Her Gym") != 1 {
			t.Errorf("Nishtha's own crossing missing:%s", describeItems(hers))
		}
		for _, it := range hers {
			if it["type"] == "geo" && it["placeName"] != "Her Gym" {
				t.Errorf("Nishtha sees Harsh's fence event: %s", itemLine(it))
			}
			if it["type"] == "reminder" {
				r := it["reminder"].(map[string]any)
				if r["body"] != "pick up keys" || r["fromName"] != "Harsh" {
					t.Errorf("Nishtha's reminder = %v", r)
				}
			}
		}
		if raw, _ := json.Marshal(hers); strings.Contains(string(raw), "Grocery") || strings.Contains(string(raw), `"Gym"`) {
			t.Errorf("Nishtha's feed shows she is watched at Harsh's fences: %s", raw)
		}

		// Live, too: Harsh's socket carried only the Grocery events.
		for _, f := range drainFor(t, harshWS, 200*time.Millisecond) {
			if f.Type == hub.FrameGeo && !strings.Contains(string(f.Data), `"Grocery"`) {
				t.Errorf("Harsh's socket carried a geo frame he was not entitled to: %s", f.Data)
			}
		}
		for _, f := range drainFor(t, nishthaWS, 200*time.Millisecond) {
			if f.Type == hub.FrameGeo && !strings.Contains(string(f.Data), "Her Gym") {
				t.Errorf("Nishtha's socket carried Harsh's geo frame: %s", f.Data)
			}
		}
	})
}

// Harsh removes Nishtha. What each of them already had stays theirs; nothing
// she does afterwards reaches his history, and nothing of his reaches hers.
func TestActivityAfterRemovingAConnection(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		s := newActStack(t, be.open(t), actOptions{coolOff: 5 * time.Millisecond})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)

		watched := circle("Grocery", actGrocery, "arrive", "leave")
		watched["watchUserIds"] = []string{nishtha.id}
		grocery := s.place(harsh, watched)
		s.note(harsh, map[string]any{
			"text": "buy milk", "placeId": grocery, "trigger": "arrive",
			"watchUserId": nishtha.id, "notifyUserIds": []string{harsh.id, nishtha.id},
		})

		// Twice while connected: the cool-off is short, so the second walk is
		// heard too — which is what makes the silence after the removal mean
		// something.
		s.walkThrough(nishtha, actGrocery)
		time.Sleep(30 * time.Millisecond)
		s.walkThrough(nishtha, actGrocery)

		mineBefore := s.waitActivity(harsh, "?from=-1h", func(items []map[string]any) bool {
			return countLines(items, "geo Nishtha leave Grocery") == 2 && countLines(items, "reminder") == 4
		})
		hersBefore := s.waitActivity(nishtha, "?from=-1h", func(items []map[string]any) bool {
			return countLines(items, `reminder note "buy milk"`) == 2
		})
		if n := countLines(mineBefore, "geo Nishtha arrive Grocery"); n != 2 {
			t.Fatalf("while connected Harsh saw %d of her 2 arrivals:%s", n, describeItems(mineBefore))
		}

		s.call(harsh, http.MethodDelete, "/api/v1/people/"+nishtha.id, nil, http.StatusNoContent)
		harshWS := s.ws(harsh)
		time.Sleep(50 * time.Millisecond)

		// She walks through again, and stops there after that.
		s.walkThrough(nishtha, actGrocery)
		time.Sleep(50 * time.Millisecond)
		s.pub(nishtha, actGrocery.Lat, actGrocery.Lon, 0.4)
		time.Sleep(400 * time.Millisecond)

		noGeoOrNotify(t, drainFor(t, harshWS, 300*time.Millisecond), "Harsh")

		mine := s.activity(harsh, "?from=-1h")
		hers := s.activity(nishtha, "?from=-1h")
		has := func(items []map[string]any, id string) bool {
			for _, it := range items {
				if it["id"] == id {
					return true
				}
			}
			return false
		}
		for _, it := range mineBefore {
			if !has(mine, it["id"].(string)) {
				t.Errorf("removing Nishtha erased Harsh's earlier %s", itemLine(it))
			}
		}
		for _, it := range hersBefore {
			if !has(hers, it["id"].(string)) {
				t.Errorf("being removed erased Nishtha's earlier %s", itemLine(it))
			}
		}
		if countLines(mine, "connection removed Nishtha byMe=true") != 1 {
			t.Errorf("Harsh's feed lacks the removal:%s", describeItems(mine))
		}
		if countLines(hers, "connection removed Harsh byMe=false") != 1 {
			t.Errorf("Nishtha's feed lacks the removal:%s", describeItems(hers))
		}
		if extra := len(mine) - len(mineBefore); extra != 1 {
			t.Errorf("Harsh's feed grew by %d after the removal, want only the removal:%s", extra, describeItems(mine))
		}
		if extra := len(hers) - len(hersBefore); extra != 1 {
			t.Errorf("Nishtha's feed grew by %d after the removal, want only the removal:%s", extra, describeItems(hers))
		}
		// Her earlier reminder is still the one Harsh sent her.
		for _, it := range hers {
			if it["type"] == "reminder" && it["reminder"].(map[string]any)["fromName"] != "Harsh" {
				t.Errorf("Nishtha's earlier reminder = %v", it)
			}
		}
	})
}

// ---------------------------------------------------------------- history scope

// History and its exports are a person's own data: another person's device —
// connected or not — is a 404, exactly like a device that does not exist.
func TestHistoryEndpointsNeverReturnAnotherUsersDevice(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		st := be.open(t)
		s := newActStack(t, st, actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)
		t0 := time.Now().UTC().Add(-90 * time.Minute)
		commuteDay(t, st, harsh, t0)
		commuteDay(t, st, nishtha, t0)

		for _, path := range []string{
			"/api/v1/history?from=-2h&deviceId=" + nishtha.deviceID,
			"/api/v1/history/export?from=-2h&format=geojson&deviceId=" + nishtha.deviceID,
			"/api/v1/history/export?from=-2h&format=gpx&deviceId=" + nishtha.deviceID,
			"/api/v1/history?from=-2h&deviceId=dev_nope",
			"/api/v1/history/export?from=-2h&deviceId=dev_nope",
			"/api/v1/devices/" + nishtha.deviceID,
		} {
			code, body, _ := s.raw(harsh.token, http.MethodGet, path, nil)
			if code != http.StatusNotFound {
				t.Errorf("Harsh GET %s = %d, want 404: %.120s", path, code, body)
			}
			if strings.Contains(string(body), "12.9") {
				t.Errorf("Harsh GET %s carries coordinates: %.200s", path, body)
			}
		}

		// His own device, and everything of his, is his — and only his.
		own := s.call(harsh, http.MethodGet, "/api/v1/history?from=-2h&deviceId="+harsh.deviceID, nil, http.StatusOK)
		all := s.call(harsh, http.MethodGet, "/api/v1/history?from=-2h", nil, http.StatusOK)
		if own["points"].(float64) != 52 || all["points"].(float64) != 52 {
			t.Errorf("Harsh's history points = %v (device) / %v (all), want 52 each", own["points"], all["points"])
		}
		for _, format := range []string{"gpx", "geojson"} {
			code, body, _ := s.raw(harsh.token, http.MethodGet, "/api/v1/history/export?from=-2h&format="+format, nil)
			if code != http.StatusOK || !strings.Contains(string(body), "77.6") {
				t.Errorf("Harsh's %s export = %d: %.200s", format, code, body)
			}
			if strings.Contains(string(body), "77.7111") {
				t.Errorf("Harsh's %s export carries Nishtha's points", format)
			}
		}
		for _, path := range []string{"/api/v1/history?from=-2h", "/api/v1/activity?from=-2h"} {
			if _, body, _ := s.raw(harsh.token, http.MethodGet, path, nil); strings.Contains(string(body), "77.7111") {
				t.Errorf("Harsh GET %s carries Nishtha's points", path)
			}
		}
		hers := s.call(nishtha, http.MethodGet, "/api/v1/history?from=-2h&deviceId="+nishtha.deviceID, nil, http.StatusOK)
		if hers["points"].(float64) != 52 {
			t.Errorf("Nishtha's own history = %v points", hers["points"])
		}

		// Erasing his history leaves hers.
		s.call(harsh, http.MethodDelete, "/api/v1/history?all=true", nil, http.StatusOK)
		hers = s.call(nishtha, http.MethodGet, "/api/v1/history?from=-2h", nil, http.StatusOK)
		if hers["points"].(float64) != 52 {
			t.Errorf("Harsh's delete touched Nishtha's history: %v points left", hers["points"])
		}
	})
}

// Every change to a connection is in both people's history, each from their
// own side, and stays there across a restart.
func TestActivityRecordsEveryConnectionChange(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		s := newActStack(t, be.open(t), actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		step := func() { time.Sleep(5 * time.Millisecond) } // distinct timestamps
		s.connect(harsh, nishtha)
		step()
		s.call(nishtha, http.MethodPatch, "/api/v1/people/"+harsh.id, map[string]any{"sharing": false}, http.StatusOK)
		step()
		s.call(nishtha, http.MethodPatch, "/api/v1/people/"+harsh.id, map[string]any{"sharing": true}, http.StatusOK)
		step()
		s.call(harsh, http.MethodDelete, "/api/v1/people/"+nishtha.id, nil, http.StatusNoContent)

		wantHarsh := []string{
			"connection invited Nishtha byMe=true",
			"connection accepted Nishtha byMe=false",
			"connection paused Nishtha byMe=false",
			"connection resumed Nishtha byMe=false",
			"connection removed Nishtha byMe=true",
		}
		wantHers := []string{
			"connection invited Harsh byMe=false",
			"connection accepted Harsh byMe=true",
			"connection paused Harsh byMe=true",
			"connection resumed Harsh byMe=true",
			"connection removed Harsh byMe=false",
		}
		check := func(s *actStack, p actPerson, want []string) {
			t.Helper()
			items := s.activity(p, "?from=-1h")
			var got []string
			for _, it := range chronological(items) {
				got = append(got, itemLine(it))
			}
			if strings.Join(got, "\n") != strings.Join(want, "\n") {
				t.Errorf("%s's history:\n%s\nwant:\n%s", p.name, strings.Join(got, "\n"), strings.Join(want, "\n"))
			}
		}
		check(s, harsh, wantHarsh)
		check(s, nishtha, wantHers)

		if !be.durable {
			return
		}
		s.stop()
		s2 := newActStack(t, be.open(t), actOptions{})
		h2, n2 := s2.harshAndNishtha()
		check(s2, h2, wantHarsh)
		check(s2, n2, wantHers)
	})
}
