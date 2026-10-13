package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/store"
)

// History is the user's activity (release spec §7), told as Harsh and Nishtha
// would live it: real fixes posted to /pub, real sockets, real acks, and the
// feed read back over GET /api/v1/activity — against the memory store and,
// when LURA_TEST_DATABASE_URL is set, PostgreSQL (including a restart).

// The commute, on a line north: Home, then Grocery, then Office.
var (
	actHome    = domain.Point{Lat: 12.8900, Lon: 77.6000}
	actGrocery = domain.Point{Lat: 12.9100, Lon: 77.6000}
	actOffice  = domain.Point{Lat: 12.9300, Lon: 77.6000}
	actGym     = domain.Point{Lat: 12.9500, Lon: 77.6000}
	actGym2    = domain.Point{Lat: 12.9700, Lon: 77.6000}
	actHerGym  = domain.Point{Lat: 12.9900, Lon: 77.6000}
)

func circle(name string, at domain.Point, triggers ...string) map[string]any {
	return map[string]any{
		"name": name, "center": map[string]float64{"lat": at.Lat, "lon": at.Lon},
		"radiusM": 100, "triggers": triggers,
	}
}

// Harsh drives Home → Grocery → Office. Leaving Home, passing Grocery (where
// "buy milk" waits), acknowledging it and arriving at the Office are, in that
// order, his history — and still are after the server restarts.
func TestActivityCommuteTimeline(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		s := newActStack(t, be.open(t), actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		s.connect(harsh, nishtha)

		s.place(harsh, circle("Home", actHome, "leave"))
		s.place(harsh, circle("Grocery", actGrocery, "passby"))
		s.place(harsh, circle("Office", actOffice, "arrive"))
		s.note(harsh, map[string]any{"text": "buy milk", "placeId": placeIDByName(t, s, harsh, "Grocery"), "trigger": "passby"})

		harshWS := s.ws(harsh)
		nishthaWS := s.ws(nishtha)

		s.pub(harsh, actHome.Lat, actHome.Lon, 0)
		s.pub(harsh, actHome.Lat+0.005, actHome.Lon, 12) // out of Home: left
		s.pub(harsh, actGrocery.Lat, actGrocery.Lon, 12) // through Grocery at speed: passed
		s.pub(harsh, actGrocery.Lat+0.005, actGrocery.Lon, 12)

		var reminder map[string]any
		for reminder == nil {
			f := nextFrame(t, harshWS, hub.FrameNotify, 5*time.Second)
			var msg map[string]any
			if err := json.Unmarshal(f.Data, &msg); err != nil {
				t.Fatal(err)
			}
			if msg["body"] == "buy milk" {
				reminder = msg
			}
		}
		id, _ := reminder["id"].(string)
		if id == "" || reminder["status"] != "pending" {
			t.Fatalf("live reminder = %v, want a stored pending record", reminder)
		}
		s.call(harsh, http.MethodPost, "/api/v1/reminders/"+id+"/ack", nil, http.StatusOK)
		nextFrame(t, harshWS, hub.FrameReminderAck, 5*time.Second)
		// The ack and the arrival are distinct moments.
		time.Sleep(20 * time.Millisecond)

		s.pub(harsh, actOffice.Lat, actOffice.Lon, 0.4) // slow, inside: arrived
		for {
			f := nextFrame(t, harshWS, hub.FrameGeo, 5*time.Second)
			var ev domain.GeoEvent
			_ = json.Unmarshal(f.Data, &ev)
			if ev.PlaceName == "Office" && ev.Trigger == domain.TriggerArrive {
				break
			}
		}

		want := []string{
			"geo Harsh leave Home",
			"geo Harsh passby Grocery",
			`reminder note "buy milk" acknowledged`,
			"ack Harsh byMe=true",
			"geo Harsh arrive Office",
		}
		feed := s.waitActivity(harsh, "?from=-1h", func(items []map[string]any) bool {
			return countLines(items, "geo Harsh arrive Office") == 1
		})
		assertNewestFirst(t, feed)
		if !subsequence(feed, want) {
			t.Fatalf("Harsh's commute reads out of order; want %q in order in:%s", want, describeItems(feed))
		}
		for _, line := range want {
			if n := countLines(feed, line); n != 1 {
				t.Errorf("%q appears %d times, want once:%s", line, n, describeItems(feed))
			}
		}
		// The crossing and its reminder join by id; his crossings are his phone's.
		var crossing, remEvent string
		for _, it := range feed {
			switch it["type"] {
			case "geo":
				if it["deviceId"] != harsh.deviceID || it["subjectUserId"] != harsh.id {
					t.Errorf("geo item = %v, want Harsh's own phone", it)
				}
				if it["placeName"] == "Grocery" {
					crossing, _ = it["eventId"].(string)
				}
			case "reminder":
				remEvent, _ = it["reminder"].(map[string]any)["eventId"].(string)
			}
		}
		if crossing == "" || crossing != remEvent {
			t.Errorf("Grocery crossing eventId %q, reminder eventId %q: want them equal", crossing, remEvent)
		}
		for _, line := range []string{"connection invited Nishtha byMe=true", "connection accepted Nishtha byMe=false"} {
			if countLines(feed, line) != 1 {
				t.Errorf("Harsh's feed lacks %q:%s", line, describeItems(feed))
			}
		}

		// Nishtha is connected but watches nothing of his: she learns nothing
		// of his commute, live or in history.
		for _, f := range drainFor(t, nishthaWS, 300*time.Millisecond) {
			if f.Type == hub.FrameGeo || f.Type == hub.FrameNotify {
				t.Errorf("Nishtha's socket carried Harsh's %s: %s", f.Type, f.Data)
			}
		}
		hers := s.activity(nishtha, "?from=-1h")
		for _, it := range hers {
			if it["type"] != "connection" {
				t.Errorf("Nishtha's feed has %s", itemLine(it))
			}
		}

		if !be.durable {
			return
		}
		// ---- restart: a new process over the same database.
		before := itemIDs(feed)
		s.stop()
		s2 := newActStack(t, be.open(t), actOptions{})
		harsh2, _ := s2.harshAndNishtha()
		after := s2.activity(harsh2, "?from=-1h")
		if !reflect.DeepEqual(itemIDs(after), before) {
			t.Errorf("feed changed across a restart:\nbefore %v\nafter  %v", before, itemIDs(after))
		}
		if !subsequence(after, want) {
			t.Errorf("after a restart the commute reads:%s", describeItems(after))
		}
		if pending := s2.call(harsh2, http.MethodGet, "/api/v1/reminders?status=pending", nil, http.StatusOK)["reminders"].([]any); len(pending) != 0 {
			t.Errorf("an acknowledged reminder is pending again after a restart: %v", pending)
		}
	})
}

func placeIDByName(t *testing.T, s *actStack, p actPerson, name string) string {
	t.Helper()
	body := s.call(p, http.MethodGet, "/api/v1/places", nil, http.StatusOK)
	for _, raw := range body["places"].([]any) {
		pl := raw.(map[string]any)
		if pl["name"] == name {
			return pl["id"].(string)
		}
	}
	t.Fatalf("%s has no place %q", p.name, name)
	return ""
}

// ---------------------------------------------------------------- day windows

// commuteDay lays down a stop at Home, a drive north and a stop at the Office
// for one phone, starting at t0, straight into the store as a past day.
// commuteLon keeps each person's commute on their own meridian, so a leak of
// one person's points into another's response is visible in the numbers.
func commuteLon(p actPerson) float64 {
	if p.id == "usr_nishtha" {
		return 77.7111
	}
	return 77.6
}

func commuteDay(t *testing.T, st store.Store, p actPerson, t0 time.Time) {
	t.Helper()
	var ps []domain.Position
	ts := t0
	add := func(lat float64, speed float64) {
		ps = append(ps, domain.Position{
			DeviceID: p.deviceID, UserID: p.id, RecvTS: ts, DeviceTS: ts, FixTS: ts,
			Point: domain.Point{Lat: lat, Lon: commuteLon(p)}, SpeedMPS: speed,
		})
		ts = ts.Add(30 * time.Second)
	}
	for i := 0; i < 20; i++ {
		add(actHome.Lat, 0)
	}
	for i := 0; i < 12; i++ {
		add(actHome.Lat+float64(i+1)*0.0034, 11)
	}
	for i := 0; i < 20; i++ {
		add(actHome.Lat+12*0.0034, 0)
	}
	if _, err := st.InsertPositions(context.Background(), ps); err != nil {
		t.Fatalf("InsertPositions: %v", err)
	}
}

// The history screen asks for one local day at a time. Whatever the zone, a
// day holds that day's trips, stops and events and nothing of the next.
func TestActivityDayWindowsAndTimezones(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		st := be.open(t)
		s := newActStack(t, st, actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		ctx := context.Background()
		grocery := s.place(harsh, circle("Grocery", actGrocery, "passby"))

		oct11 := time.Date(2026, 10, 11, 8, 30, 0, 0, time.UTC)
		oct12 := time.Date(2026, 10, 12, 8, 30, 0, 0, time.UTC)
		commuteDay(t, st, harsh, oct11)
		commuteDay(t, st, harsh, oct12)
		commuteDay(t, st, nishtha, oct12) // hers, never in his feed

		cross := func(at time.Time) {
			t.Helper()
			if _, err := st.InsertTriggerEvent(ctx, domain.TriggerEvent{
				UserID: harsh.id, PlaceID: grocery, PlaceName: "Grocery", DeviceID: harsh.deviceID,
				Trigger: domain.TriggerPassby, TS: at, SubjectUserID: harsh.id, SubjectName: "Harsh",
				GeoEventID: "geo_" + at.Format("150405"), NoteIDs: []string{}, Delivered: []string{},
			}); err != nil {
				t.Fatal(err)
			}
		}
		cross(oct12.Add(10 * time.Minute))                     // 08:40Z on the 12th
		cross(time.Date(2026, 10, 12, 18, 29, 0, 0, time.UTC)) // 23:59 IST on the 12th
		cross(time.Date(2026, 10, 12, 18, 31, 0, 0, time.UTC)) // 00:01 IST on the 13th
		cross(time.Date(2026, 10, 12, 23, 30, 0, 0, time.UTC)) // 23:30Z on the 12th, 05:00 IST on the 13th

		q := func(from, to string) string {
			return "?" + url.Values{"from": {from}, "to": {to}, "limit": {"500"}}.Encode()
		}
		geoTimes := func(items []map[string]any) []string {
			var out []string
			for _, it := range chronological(items) {
				if it["type"] == "geo" {
					ts, _ := time.Parse(time.RFC3339, it["ts"].(string))
					out = append(out, ts.UTC().Format("15:04"))
				}
			}
			return out
		}
		countType := func(items []map[string]any, typ string) int {
			n := 0
			for _, it := range items {
				if it["type"] == typ {
					n++
				}
			}
			return n
		}

		// The 12th in UTC.
		utc := s.activity(harsh, q("2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"))
		assertNewestFirst(t, utc)
		if got := strings.Join(geoTimes(utc), ","); got != "08:40,18:29,18:31,23:30" {
			t.Errorf("UTC 12th crossings = %s", got)
		}
		if countType(utc, "trip") != 1 || countType(utc, "stop") != 2 {
			t.Errorf("UTC 12th = %d trips, %d stops, want 1 and 2:%s", countType(utc, "trip"), countType(utc, "stop"), describeItems(utc))
		}
		for _, it := range utc {
			if (it["type"] == "trip" || it["type"] == "stop") && it["deviceId"] != harsh.deviceID {
				t.Errorf("another person's movement in Harsh's day: %v", itemLine(it))
			}
			if ts, _ := time.Parse(time.RFC3339, it["ts"].(string)); ts.Before(time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)) {
				t.Errorf("an item from before the day: %s", itemLine(it))
			}
		}

		// The 12th in India, as an offset, and as the client sends it (UTC
		// instants of the zone's midnights): the same day either way.
		ist := s.activity(harsh, q("2026-10-12T00:00:00+05:30", "2026-10-13T00:00:00+05:30"))
		istZ := s.activity(harsh, q("2026-10-11T18:30:00.000Z", "2026-10-12T18:30:00.000Z"))
		if !reflect.DeepEqual(itemIDs(ist), itemIDs(istZ)) {
			t.Errorf("an offset window and its UTC instants differ:%s\nvs%s", describeItems(ist), describeItems(istZ))
		}
		if got := strings.Join(geoTimes(ist), ","); got != "08:40,18:29" {
			t.Errorf("IST 12th crossings = %s, want 08:40 and 18:29 (23:59 IST)", got)
		}
		if countType(ist, "trip") != 1 {
			t.Errorf("IST 12th trips = %d", countType(ist, "trip"))
		}
		next := s.activity(harsh, q("2026-10-13T00:00:00+05:30", "2026-10-14T00:00:00+05:30"))
		if got := strings.Join(geoTimes(next), ","); got != "18:31,23:30" {
			t.Errorf("IST 13th crossings = %s, want 18:31 and 23:30", got)
		}
		if countType(next, "trip")+countType(next, "stop") != 0 {
			t.Errorf("IST 13th has movement:%s", describeItems(next))
		}

		// The 11th has its own commute and none of the 12th's crossings.
		prev := s.activity(harsh, q("2026-10-11T00:00:00Z", "2026-10-12T00:00:00Z"))
		if countType(prev, "trip") != 1 || countType(prev, "geo") != 0 {
			t.Errorf("UTC 11th:%s", describeItems(prev))
		}

		// limit keeps the newest.
		two := s.activity(harsh, "?from=2026-10-12T00:00:00Z&to=2026-10-13T00:00:00Z&limit=2")
		if len(two) != 2 || !reflect.DeepEqual(itemIDs(two), itemIDs(utc)[:2]) {
			t.Errorf("limit=2 = %v, want the two newest of %v", itemIDs(two), itemIDs(utc))
		}

		// Nishtha's own day is hers.
		hers := s.activity(nishtha, q("2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z"))
		if countType(hers, "trip") != 1 || countType(hers, "geo") != 0 {
			t.Errorf("Nishtha's 12th:%s", describeItems(hers))
		}

		// Bad windows are the caller's mistake.
		for _, bad := range []string{
			"?from=yesterday",
			"?from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z",
			"?to=-nonsense",
		} {
			if code, _, _ := s.raw(harsh.token, http.MethodGet, "/api/v1/activity"+bad, nil); code != http.StatusBadRequest {
				t.Errorf("GET /activity%s = %d, want 400", bad, code)
			}
		}
		// Anonymous callers get nothing.
		if code, _, _ := s.raw("", http.MethodGet, "/api/v1/activity", nil); code != http.StatusUnauthorized {
			t.Errorf("anonymous activity = %d, want 401", code)
		}
	})
}

// A reminder that arrived just before midnight and was acknowledged just
// after is in both days: the reminder on the first, the ack on the second.
func TestActivityAckAcrossMidnight(t *testing.T) {
	eachActBackend(t, func(t *testing.T, be actBackend) {
		st := be.open(t)
		s := newActStack(t, st, actOptions{})
		harsh, nishtha := s.harshAndNishtha()
		ctx := context.Background()
		created := time.Date(2026, 10, 12, 23, 58, 0, 0, time.UTC)
		acked := time.Date(2026, 10, 13, 0, 2, 0, 0, time.UTC)
		rec, err := st.SaveReminder(ctx, domain.ReminderRecord{
			UserID: harsh.id, OwnerID: harsh.id, Kind: domain.ReminderKindNote, Title: "Passed by Grocery",
			Body: "buy milk", PlaceName: "Grocery", Trigger: domain.TriggerPassby, CreatedAt: created,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := st.AckReminder(ctx, harsh.id, rec.ID, acked); err != nil {
			t.Fatal(err)
		}
		lines := func(items []map[string]any) string {
			var out []string
			for _, it := range chronological(items) {
				out = append(out, itemLine(it))
			}
			return strings.Join(out, " | ")
		}
		if got := lines(s.activity(harsh, "?from=2026-10-12T00:00:00Z&to=2026-10-12T23:59:59.999Z")); got != `reminder note "buy milk" acknowledged` {
			t.Errorf("the 12th = %q", got)
		}
		if got := lines(s.activity(harsh, "?from=2026-10-13T00:00:00Z&to=2026-10-13T23:59:59.999Z")); got != "ack Harsh byMe=true" {
			t.Errorf("the 13th = %q", got)
		}
		// Nishtha has neither.
		if got := s.activity(nishtha, "?from=2026-10-12T00:00:00Z&to=2026-10-14T00:00:00Z"); len(got) != 0 {
			t.Errorf("Nishtha's feed:%s", describeItems(got))
		}
	})
}
