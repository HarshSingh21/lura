package activity_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/activity"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

const (
	me   = "u_harsh"
	peer = "u_nishtha"
)

// day lays down a stop at home, a drive, and a stop at the office for one
// device, starting at t0, and returns the end time.
func day(t *testing.T, st *memory.Store, userID, deviceID string, t0 time.Time) time.Time {
	t.Helper()
	var ps []domain.Position
	ts := t0
	add := func(lat, lon, speed float64) {
		ps = append(ps, domain.Position{
			DeviceID: deviceID, UserID: userID, RecvTS: ts, DeviceTS: ts,
			Point: domain.Point{Lat: lat, Lon: lon}, SpeedMPS: speed,
		})
		ts = ts.Add(30 * time.Second)
	}
	for i := 0; i < 20; i++ { // 10 minutes at home
		add(12.9000, 77.6000, 0)
	}
	for i := 0; i < 12; i++ { // 6 minutes driving north, ~350 m per fix
		add(12.9000+float64(i+1)*0.0032, 77.6000, 11)
	}
	for i := 0; i < 20; i++ { // 10 minutes at the office
		add(12.9000+12*0.0032, 77.6000, 0)
	}
	if _, err := st.InsertPositions(context.Background(), ps); err != nil {
		t.Fatalf("InsertPositions: %v", err)
	}
	return ts
}

type fixture struct {
	st *memory.Store
	t0 time.Time
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	ctx := context.Background()
	st := memory.New()
	for _, u := range []domain.User{{ID: me, DisplayName: "Harsh"}, {ID: peer, DisplayName: "Nishtha"}} {
		if err := st.UpsertUser(ctx, u); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []domain.Device{
		{ID: "dev_harsh", UserID: me, Name: "Harsh's Phone", Token: "a"},
		{ID: "dev_nishtha", UserID: peer, Name: "Nishtha's Phone", Token: "b"},
	} {
		if err := st.UpsertDevice(ctx, d); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.CreatePlace(ctx, domain.Place{ID: "p_grocery", UserID: me, Name: "Grocery",
		Center: domain.Point{Lat: 12.92, Lon: 77.6}, RadiusM: 80, Triggers: []domain.Trigger{domain.TriggerPassby}}); err != nil {
		t.Fatal(err)
	}
	t0 := time.Date(2026, 10, 12, 8, 30, 0, 0, time.UTC)
	day(t, st, me, "dev_harsh", t0)
	// The peer's whole day is in the store too — and must never surface.
	day(t, st, peer, "dev_nishtha", t0)
	return &fixture{st: st, t0: t0}
}

func TestFeedMergesEverySourceNewestFirst(t *testing.T) {
	f := newFixture(t)
	ctx := context.Background()
	st, t0 := f.st, f.t0

	// My crossing of Grocery, and Nishtha's (I watch her on it).
	for _, e := range []domain.TriggerEvent{
		{UserID: me, PlaceID: "p_grocery", PlaceName: "Grocery", DeviceID: "dev_harsh", Trigger: domain.TriggerPassby,
			TS: t0.Add(13 * time.Minute), NoteIDs: []string{"n1"}, Delivered: []string{"inapp"}, SubjectUserID: me, SubjectName: "Harsh"},
		{UserID: me, PlaceID: "p_grocery", PlaceName: "Grocery", DeviceID: "dev_nishtha", Trigger: domain.TriggerPassby,
			TS: t0.Add(40 * time.Minute), SubjectUserID: peer, SubjectName: "Nishtha"},
		// Nishtha's own fence event: hers, not mine.
		{UserID: peer, PlaceName: "Her Gym", DeviceID: "dev_nishtha", Trigger: domain.TriggerArrive, TS: t0.Add(20 * time.Minute)},
	} {
		if _, err := st.InsertTriggerEvent(ctx, e); err != nil {
			t.Fatal(err)
		}
	}

	// A reminder I received and acknowledged a minute later.
	rem, _ := st.SaveReminder(ctx, domain.ReminderRecord{UserID: me, OwnerID: me, NoteIDs: []string{"n1"},
		Kind: domain.ReminderKindNote, Title: "Passing Grocery", Body: "buy milk", PlaceName: "Grocery",
		EventID: "geo_a", CreatedAt: t0.Add(13 * time.Minute)})
	if _, _, err := st.AckReminder(ctx, me, rem.ID, t0.Add(14*time.Minute)); err != nil {
		t.Fatal(err)
	}
	// Nishtha acknowledged my note: stored for me as kind "ack".
	at := t0.Add(45 * time.Minute)
	if _, err := st.SaveReminder(ctx, domain.ReminderRecord{UserID: me, OwnerID: me, Kind: domain.ReminderKindAck,
		Title: "Nishtha acknowledged buy milk", Body: "buy milk", FromUserID: peer, FromName: "Nishtha",
		CreatedAt: at, Status: domain.ReminderAcknowledged, AckedAt: &at, AckedBy: peer}); err != nil {
		t.Fatal(err)
	}
	// Nishtha's own reminder: not mine to see.
	if _, err := st.SaveReminder(ctx, domain.ReminderRecord{UserID: peer, OwnerID: me, Title: "secret",
		EventID: "geo_a", CreatedAt: t0.Add(13 * time.Minute)}); err != nil {
		t.Fatal(err)
	}

	if _, err := st.InsertConnectionEvent(ctx, domain.ConnectionEvent{UserID: me, PeerID: peer, PeerName: "Nishtha",
		Action: domain.ConnectionActionPaused, ActorID: peer, TS: t0.Add(50 * time.Minute)}); err != nil {
		t.Fatal(err)
	}
	sh, err := st.CreateShare(ctx, domain.Share{UserID: me, Token: "tok", Label: "Mum", Mode: domain.ShareUntilRevoke,
		CreatedAt: t0.Add(5 * time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.RevokeShare(ctx, me, sh.ID, "done", t0.Add(55*time.Minute)); err != nil {
		t.Fatal(err)
	}

	svc := activity.New(st, nil)
	res, err := svc.Feed(ctx, me, activity.Query{From: t0, To: t0.Add(time.Hour)})
	if err != nil {
		t.Fatalf("Feed: %v", err)
	}
	raw, _ := json.Marshal(res)
	var decoded struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}

	counts := map[string]int{}
	var prev time.Time
	for i, it := range decoded.Items {
		typ, _ := it["type"].(string)
		counts[typ]++
		ts, err := time.Parse(time.RFC3339, it["ts"].(string))
		if err != nil {
			t.Fatalf("item %d ts %v is not RFC3339: %v", i, it["ts"], err)
		}
		if i > 0 && ts.After(prev) {
			t.Errorf("item %d (%s at %s) is newer than the one before it (%s)", i, typ, ts, prev)
		}
		prev = ts

		// Privacy: nothing of Nishtha's own track or records.
		if it["deviceId"] == "dev_nishtha" && (typ == "trip" || typ == "stop") {
			t.Errorf("peer's movement leaked as a %s: %v", typ, it)
		}
		if typ == "geo" && it["placeName"] == "Her Gym" {
			t.Error("peer's own fence event leaked")
		}
		if typ == "reminder" {
			if r := it["reminder"].(map[string]any); r["title"] == "secret" {
				t.Error("peer's reminder leaked")
			}
		}
	}
	want := map[string]int{"trip": 1, "stop": 2, "geo": 2, "reminder": 1, "ack": 2, "connection": 1, "share": 2}
	for typ, n := range want {
		if counts[typ] != n {
			t.Errorf("%s items = %d, want %d (all: %v)", typ, counts[typ], n, counts)
		}
	}

	// Newest is the share revocation at +55m.
	if first := decoded.Items[0]; first["type"] != "share" || first["action"] != "revoked" {
		t.Errorf("newest item = %v", first)
	}
	// The watched peer's crossing reads as hers.
	for _, it := range decoded.Items {
		if it["type"] == "geo" && it["deviceId"] == "dev_nishtha" && it["subjectName"] != "Nishtha" {
			t.Errorf("peer crossing = %v", it)
		}
		if it["type"] == "ack" && it["byMe"] == false && it["ackedByName"] != "Nishtha" {
			t.Errorf("peer ack = %v", it)
		}
		if it["type"] == "connection" && (it["byMe"] != false || it["action"] != "paused") {
			t.Errorf("connection = %v", it)
		}
		if it["type"] == "trip" {
			if it["deviceName"] != "Harsh's Phone" || it["distanceM"].(float64) < 3000 {
				t.Errorf("trip = %v", it)
			}
		}
	}

	// Limit keeps the newest.
	limited, _ := svc.Feed(ctx, me, activity.Query{From: t0, To: t0.Add(time.Hour), Limit: 3})
	if len(limited.Items) != 3 {
		t.Errorf("limit 3 = %d items", len(limited.Items))
	}
	// A window before anything happened is empty, and an array.
	empty, _ := svc.Feed(ctx, me, activity.Query{From: t0.Add(-3 * time.Hour), To: t0.Add(-2 * time.Hour)})
	if empty.Items == nil || len(empty.Items) != 0 {
		t.Errorf("empty window = %#v", empty.Items)
	}
}

func TestFeedRejectsAnInvertedWindow(t *testing.T) {
	f := newFixture(t)
	if _, err := activity.New(f.st, nil).Feed(context.Background(), me, activity.Query{
		From: f.t0.Add(time.Hour), To: f.t0,
	}); err == nil {
		t.Error("from after to accepted")
	}
}
