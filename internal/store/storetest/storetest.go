// Package storetest is a conformance suite every store.Store implementation must
// pass.
//
// It exists because Lura has two stores — in-memory and PostgreSQL/PostGIS — and
// the whole design depends on them being interchangeable. Subtle divergence is
// the real risk: a guard that holds in SQL but not in Go (or vice versa) would
// mean the geofence engine behaves differently in tests than in production. So
// the guards themselves are asserted here, once, against both:
//
//   - the monotonic last_point update (HLD §5.3)
//   - idempotent position inserts on (device_id, recv_ts) (HLD §5.2, §10)
//   - ST_DWithin-equivalent place containment (HLD §5.4)
//   - user scoping on every read (HLD §11)
package storetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Factory builds a fresh, empty store for one subtest.
type Factory func(t *testing.T) store.Store

// Run executes the whole suite against the given factory.
func Run(t *testing.T, newStore Factory) {
	t.Helper()
	tests := []struct {
		name string
		fn   func(*testing.T, store.Store)
	}{
		{"Users", testUsers},
		{"Devices", testDevices},
		{"MonotonicLastPoint", testMonotonicLastPoint},
		{"PositionIdempotency", testPositionIdempotency},
		{"PositionQueries", testPositionQueries},
		{"Places", testPlaces},
		{"PlacesContaining", testPlacesContaining},
		{"Notes", testNotes},
		{"NoteResolution", testNoteResolution},
		{"Shares", testShares},
		{"Channels", testChannels},
		{"TriggerEvents", testTriggerEvents},
		{"PendingDwells", testPendingDwells},
		{"UserScoping", testUserScoping},
		{"PlaceStats", testPlaceStats},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			st := newStore(t)
			tc.fn(t, st)
		})
	}
}

// ---------------------------------------------------------------- fixtures

func ctxFor(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func mustUser(t *testing.T, st store.Store, id string) domain.User {
	t.Helper()
	u := domain.User{ID: id, Email: id + "@lura.local", DisplayName: id, TZ: "UTC", Locale: "en"}
	if err := st.UpsertUser(ctxFor(t), u); err != nil {
		t.Fatalf("UpsertUser(%s): %v", id, err)
	}
	return u
}

func mustDevice(t *testing.T, st store.Store, userID, id string) domain.Device {
	t.Helper()
	d := domain.Device{ID: id, UserID: userID, Name: id, Kind: "phone", Token: "tok-" + id}
	if err := st.UpsertDevice(ctxFor(t), d); err != nil {
		t.Fatalf("UpsertDevice(%s): %v", id, err)
	}
	return d
}

func mustPlace(t *testing.T, st store.Store, userID, id, name string, lat, lon float64, radius int, triggers ...domain.Trigger) domain.Place {
	t.Helper()
	if len(triggers) == 0 {
		triggers = []domain.Trigger{domain.TriggerArrive}
	}
	p, err := st.CreatePlace(ctxFor(t), domain.Place{
		ID: id, UserID: userID, Name: name, Tags: []string{"test"},
		Center: domain.Point{Lat: lat, Lon: lon}, RadiusM: radius, Triggers: triggers,
	})
	if err != nil {
		t.Fatalf("CreatePlace(%s): %v", id, err)
	}
	return p
}

// ---------------------------------------------------------------- users

func testUsers(t *testing.T, st store.Store) {
	ctx := ctxFor(t)

	if _, err := st.GetUser(ctx, "nobody"); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("GetUser(missing) error = %v, want ErrNotFound", err)
	}

	mustUser(t, st, "u1")
	got, err := st.GetUser(ctx, "u1")
	if err != nil {
		t.Fatalf("GetUser: %v", err)
	}
	if got.Email != "u1@lura.local" {
		t.Errorf("Email = %q, want u1@lura.local", got.Email)
	}

	updated, err := st.UpdateUserSettings(ctx, "u1", func(u *domain.User) {
		u.Airgap = true
		u.QuietFrom, u.QuietTo = "22:00", "07:00"
		u.TZ = "Asia/Kolkata"
	})
	if err != nil {
		t.Fatalf("UpdateUserSettings: %v", err)
	}
	if !updated.Airgap || updated.QuietFrom != "22:00" || updated.TZ != "Asia/Kolkata" {
		t.Errorf("settings not applied: %+v", updated)
	}

	// Settings must survive a re-read, not just be echoed back.
	reread, err := st.GetUser(ctx, "u1")
	if err != nil {
		t.Fatalf("GetUser after update: %v", err)
	}
	if !reread.Airgap {
		t.Error("airgap did not persist")
	}
}

// ---------------------------------------------------------------- devices

func testDevices(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustDevice(t, st, "u1", "d1")

	got, err := st.GetDevice(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if got.Name != "d1" || got.Token != "tok-d1" {
		t.Errorf("device = %+v", got)
	}

	byToken, err := st.DeviceByToken(ctx, "tok-d1")
	if err != nil {
		t.Fatalf("DeviceByToken: %v", err)
	}
	if byToken.ID != "d1" {
		t.Errorf("DeviceByToken id = %q, want d1", byToken.ID)
	}
	if _, err := st.DeviceByToken(ctx, "wrong"); !errors.Is(err, domain.ErrUnauthorized) {
		t.Errorf("DeviceByToken(wrong) error = %v, want ErrUnauthorized", err)
	}

	// A rename must not disturb the credential or the position state.
	renamed := got
	renamed.Name = "Renamed"
	if err := st.UpsertDevice(ctx, renamed); err != nil {
		t.Fatalf("UpsertDevice(rename): %v", err)
	}
	after, err := st.GetDevice(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("GetDevice after rename: %v", err)
	}
	if after.Name != "Renamed" {
		t.Errorf("name = %q, want Renamed", after.Name)
	}
	if after.Token != "tok-d1" {
		t.Errorf("token changed on rename: %q", after.Token)
	}

	if err := st.DeleteDevice(ctx, "u1", "d1"); err != nil {
		t.Fatalf("DeleteDevice: %v", err)
	}
	if _, err := st.GetDevice(ctx, "u1", "d1"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetDevice after delete = %v, want ErrNotFound", err)
	}
}

// testMonotonicLastPoint asserts HLD §5.3: a late or replayed fix must never
// move the live marker backwards.
func testMonotonicLastPoint(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustDevice(t, st, "u1", "d1")

	t1 := time.Now().UTC().Truncate(time.Millisecond)
	newer := domain.Point{Lat: 12.9611, Lon: 77.6387}
	older := domain.Point{Lat: 12.9000, Lon: 77.6000}

	advanced, err := st.TouchLastPoint(ctx, "d1", newer, t1, 5, 80)
	if err != nil {
		t.Fatalf("TouchLastPoint(first): %v", err)
	}
	if !advanced {
		t.Fatal("first fix did not advance last_point")
	}

	// An older fix (offline replay) must be rejected.
	advanced, err = st.TouchLastPoint(ctx, "d1", older, t1.Add(-time.Hour), 0, 70)
	if err != nil {
		t.Fatalf("TouchLastPoint(older): %v", err)
	}
	if advanced {
		t.Error("a fix older than last_seen advanced last_point")
	}

	// The same timestamp is not newer, so it must also be rejected.
	advanced, err = st.TouchLastPoint(ctx, "d1", older, t1, 0, 70)
	if err != nil {
		t.Fatalf("TouchLastPoint(equal): %v", err)
	}
	if advanced {
		t.Error("a fix with an equal timestamp advanced last_point")
	}

	dev, err := st.GetDevice(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("GetDevice: %v", err)
	}
	if dev.LastPoint == nil {
		t.Fatal("last_point is nil")
	}
	if diff := dev.LastPoint.Lat - newer.Lat; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("last_point moved backwards: got %+v, want %+v", *dev.LastPoint, newer)
	}

	// A genuinely newer fix still wins.
	if advanced, err := st.TouchLastPoint(ctx, "d1", older, t1.Add(time.Minute), 1, 60); err != nil || !advanced {
		t.Fatalf("TouchLastPoint(newer) = %v, %v; want true, nil", advanced, err)
	}
}

// testPositionIdempotency asserts the (device_id, recv_ts) idempotency key from
// HLD §5.2: at-least-once redelivery must not duplicate history.
func testPositionIdempotency(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustDevice(t, st, "u1", "d1")

	ts := time.Now().UTC().Truncate(time.Microsecond)
	fix := domain.Position{
		DeviceID: "d1", UserID: "u1", RecvTS: ts, DeviceTS: ts,
		Point: domain.Point{Lat: 12.9611, Lon: 77.6387}, SpeedMPS: 3, AccuracyM: 8, Battery: 80, Seq: 1,
	}

	n, err := st.InsertPositions(ctx, []domain.Position{fix})
	if err != nil {
		t.Fatalf("InsertPositions: %v", err)
	}
	if n != 1 {
		t.Fatalf("first insert wrote %d rows, want 1", n)
	}

	// Same key: a redelivery. Must be accepted (no error) and write nothing.
	n, err = st.InsertPositions(ctx, []domain.Position{fix})
	if err != nil {
		t.Fatalf("InsertPositions(redelivery): %v", err)
	}
	if n != 0 {
		t.Errorf("redelivery wrote %d rows, want 0", n)
	}

	// One microsecond later is a different fix — this is exactly the case
	// OwnTracks' second-resolution `tst` would have collided.
	fix2 := fix
	fix2.RecvTS = ts.Add(time.Microsecond)
	if n, err := st.InsertPositions(ctx, []domain.Position{fix2}); err != nil || n != 1 {
		t.Fatalf("InsertPositions(+1µs) = %d, %v; want 1, nil", n, err)
	}

	rows, err := st.ListPositions(ctx, "u1", store.PositionQuery{DeviceID: "d1"})
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 2 {
		t.Errorf("stored %d positions, want 2", len(rows))
	}
}

func testPositionQueries(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustDevice(t, st, "u1", "d1")

	start := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	var batch []domain.Position
	for i := 0; i < 10; i++ {
		batch = append(batch, domain.Position{
			DeviceID: "d1", UserID: "u1",
			RecvTS:   start.Add(time.Duration(i) * time.Minute),
			DeviceTS: start.Add(time.Duration(i) * time.Minute),
			Point:    domain.Point{Lat: 12.96 + float64(i)*0.001, Lon: 77.63},
			SpeedMPS: float64(i),
		})
	}
	if _, err := st.InsertPositions(ctx, batch); err != nil {
		t.Fatalf("InsertPositions: %v", err)
	}

	// Chronological order is part of the contract: the segmenter depends on it.
	rows, err := st.ListPositions(ctx, "u1", store.PositionQuery{DeviceID: "d1"})
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 10 {
		t.Fatalf("got %d rows, want 10", len(rows))
	}
	for i := 1; i < len(rows); i++ {
		if rows[i].RecvTS.Before(rows[i-1].RecvTS) {
			t.Fatalf("positions out of order at %d", i)
		}
	}

	// Window filter.
	rows, err = st.ListPositions(ctx, "u1", store.PositionQuery{
		DeviceID: "d1",
		From:     start.Add(3 * time.Minute),
		To:       start.Add(5 * time.Minute),
	})
	if err != nil {
		t.Fatalf("ListPositions(window): %v", err)
	}
	if len(rows) != 3 {
		t.Errorf("window returned %d rows, want 3", len(rows))
	}

	// A limit keeps the newest window, not the oldest.
	rows, err = st.ListPositions(ctx, "u1", store.PositionQuery{DeviceID: "d1", Limit: 3})
	if err != nil {
		t.Fatalf("ListPositions(limit): %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("limit returned %d rows, want 3", len(rows))
	}
	if !rows[len(rows)-1].RecvTS.Equal(batch[len(batch)-1].RecvTS) {
		t.Errorf("limit kept the wrong end: last = %v, want %v",
			rows[len(rows)-1].RecvTS, batch[len(batch)-1].RecvTS)
	}

	latest, err := st.LatestPosition(ctx, "u1", "d1")
	if err != nil {
		t.Fatalf("LatestPosition: %v", err)
	}
	if !latest.RecvTS.Equal(batch[9].RecvTS) {
		t.Errorf("LatestPosition = %v, want %v", latest.RecvTS, batch[9].RecvTS)
	}

	deleted, err := st.DeletePositionsBefore(ctx, "u1", start.Add(5*time.Minute))
	if err != nil {
		t.Fatalf("DeletePositionsBefore: %v", err)
	}
	if deleted != 5 {
		t.Errorf("deleted %d rows, want 5", deleted)
	}
}

// ---------------------------------------------------------------- places

func testPlaces(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")

	created := mustPlace(t, st, "u1", "p1", "Home", 12.9611, 77.6387, 120,
		domain.TriggerArrive, domain.TriggerLeave)
	if created.UpdatedAt.IsZero() {
		t.Error("UpdatedAt not stamped on create (AI cache key depends on it)")
	}
	if len(created.Triggers) != 2 {
		t.Errorf("triggers = %v, want 2", created.Triggers)
	}

	// Renaming must move UpdatedAt: it is the embedding-cache key (HLD §5.7).
	time.Sleep(2 * time.Millisecond)
	renamed := created
	renamed.Name = "Casa"
	renamed.Tags = []string{"home", "family"}
	updated, err := st.UpdatePlace(ctx, renamed)
	if err != nil {
		t.Fatalf("UpdatePlace: %v", err)
	}
	if updated.Name != "Casa" {
		t.Errorf("name = %q", updated.Name)
	}
	if !updated.UpdatedAt.After(created.UpdatedAt) {
		t.Errorf("UpdatedAt did not advance on rename: %v -> %v", created.UpdatedAt, updated.UpdatedAt)
	}
	if len(updated.Tags) != 2 {
		t.Errorf("tags = %v, want 2", updated.Tags)
	}

	if err := st.DeletePlace(ctx, "u1", "p1"); err != nil {
		t.Fatalf("DeletePlace: %v", err)
	}
	if _, err := st.GetPlace(ctx, "u1", "p1"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("GetPlace after delete = %v, want ErrNotFound", err)
	}
}

// testPlacesContaining is the geofence predicate: it must agree between
// haversine (memory) and ST_DWithin (PostGIS) at the metre level.
func testPlacesContaining(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")

	center := domain.Point{Lat: 12.9611, Lon: 77.6387}
	mustPlace(t, st, "u1", "p_small", "Shop", center.Lat, center.Lon, 60)
	mustPlace(t, st, "u1", "p_big", "District", center.Lat, center.Lon, 1000)
	mustPlace(t, st, "u1", "p_far", "Elsewhere", 12.99, 77.70, 100)

	// Dead centre: inside both concentric fences.
	inside, err := st.PlacesContaining(ctx, "u1", center)
	if err != nil {
		t.Fatalf("PlacesContaining(center): %v", err)
	}
	if len(inside) != 2 {
		t.Fatalf("at centre got %d places, want 2 (%v)", len(inside), names(inside))
	}

	// ~100 m north: outside the 60 m fence, still inside the 1 km one.
	north := domain.Point{Lat: center.Lat + 0.0009, Lon: center.Lon}
	inside, err = st.PlacesContaining(ctx, "u1", north)
	if err != nil {
		t.Fatalf("PlacesContaining(north): %v", err)
	}
	if len(inside) != 1 || inside[0].ID != "p_big" {
		t.Errorf("100m north got %v, want [p_big]", names(inside))
	}

	// Far away: nothing.
	inside, err = st.PlacesContaining(ctx, "u1", domain.Point{Lat: 13.5, Lon: 78.5})
	if err != nil {
		t.Fatalf("PlacesContaining(far): %v", err)
	}
	if len(inside) != 0 {
		t.Errorf("far away got %v, want none", names(inside))
	}
}

func names(places []domain.Place) []string {
	out := make([]string, 0, len(places))
	for _, p := range places {
		out = append(out, p.ID)
	}
	return out
}

// ---------------------------------------------------------------- notes

func testNotes(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPlace(t, st, "u1", "p1", "Home", 12.9611, 77.6387, 120)

	created, err := st.CreateNote(ctx, domain.Note{
		UserID: "u1", Text: "Water the plants", PlaceID: "p1",
		Trigger: domain.TriggerArrive, Tags: []string{"home"},
	})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	if created.ID == "" {
		t.Fatal("CreateNote did not assign an id")
	}

	// An unbound note is legal: the user's words survive without a place.
	if _, err := st.CreateNote(ctx, domain.Note{
		UserID: "u1", Text: "Someday", Trigger: domain.TriggerArrive,
	}); err != nil {
		t.Fatalf("CreateNote(unbound): %v", err)
	}

	done := created
	done.Done = true
	if _, err := st.UpdateNote(ctx, done); err != nil {
		t.Fatalf("UpdateNote: %v", err)
	}

	fired := time.Now().UTC()
	if err := st.MarkNoteFired(ctx, "u1", created.ID, fired); err != nil {
		t.Fatalf("MarkNoteFired: %v", err)
	}
	got, err := st.GetNote(ctx, "u1", created.ID)
	if err != nil {
		t.Fatalf("GetNote: %v", err)
	}
	if got.FiredAt == nil {
		t.Error("FiredAt not recorded")
	}
	if !got.Done {
		t.Error("Done flag lost")
	}

	// Deleting the place unbinds the note rather than deleting it.
	if err := st.DeletePlace(ctx, "u1", "p1"); err != nil {
		t.Fatalf("DeletePlace: %v", err)
	}
	got, err = st.GetNote(ctx, "u1", created.ID)
	if err != nil {
		t.Fatalf("GetNote after place delete: %v", err)
	}
	if got.PlaceID != "" {
		t.Errorf("note still bound to a deleted place: %q", got.PlaceID)
	}
}

// testNoteResolution is the notification worker's hot query: open notes for a
// place and trigger.
func testNoteResolution(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPlace(t, st, "u1", "p1", "Shop", 12.9611, 77.6387, 60)

	seed := []domain.Note{
		{UserID: "u1", Text: "milk", PlaceID: "p1", Trigger: domain.TriggerPassby},
		{UserID: "u1", Text: "eggs", PlaceID: "p1", Trigger: domain.TriggerPassby},
		{UserID: "u1", Text: "already bought", PlaceID: "p1", Trigger: domain.TriggerPassby, Done: true},
		{UserID: "u1", Text: "other trigger", PlaceID: "p1", Trigger: domain.TriggerArrive},
	}
	for _, n := range seed {
		if _, err := st.CreateNote(ctx, n); err != nil {
			t.Fatalf("CreateNote: %v", err)
		}
	}

	open := false
	got, err := st.ListNotes(ctx, "u1", store.NoteFilter{
		PlaceID: "p1", Trigger: domain.TriggerPassby, Done: &open,
	})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("resolved %d notes, want 2 (%v)", len(got), texts(got))
	}

	// Default listing puts open notes first — the UI order.
	all, err := st.ListNotes(ctx, "u1", store.NoteFilter{})
	if err != nil {
		t.Fatalf("ListNotes(all): %v", err)
	}
	if len(all) != 4 {
		t.Fatalf("listed %d notes, want 4", len(all))
	}
	if all[len(all)-1].Done != true {
		t.Errorf("done note is not last: %v", texts(all))
	}
}

func texts(notes []domain.Note) []string {
	out := make([]string, 0, len(notes))
	for _, n := range notes {
		out = append(out, n.Text)
	}
	return out
}

// ---------------------------------------------------------------- shares

func testShares(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPlace(t, st, "u1", "p_home", "Home", 12.9611, 77.6387, 120)

	past := time.Now().UTC().Add(-time.Minute)
	future := time.Now().UTC().Add(time.Hour)

	live, err := st.CreateShare(ctx, domain.Share{
		UserID: "u1", Label: "Priya", Mode: domain.ShareUntilArrive,
		ArrivePlace: "p_home", ExpiresAt: &future, Token: "tok-live",
	})
	if err != nil {
		t.Fatalf("CreateShare: %v", err)
	}
	if _, err := st.CreateShare(ctx, domain.Share{
		UserID: "u1", Label: "Expired", Mode: domain.ShareDuration,
		ExpiresAt: &past, Token: "tok-expired",
	}); err != nil {
		t.Fatalf("CreateShare(expired): %v", err)
	}

	// The active listing must not show an expired share, whatever the sweeper has
	// or has not got round to.
	active, err := st.ListShares(ctx, "u1", false)
	if err != nil {
		t.Fatalf("ListShares: %v", err)
	}
	if len(active) != 1 || active[0].Label != "Priya" {
		t.Errorf("active shares = %v, want [Priya]", shareLabels(active))
	}
	all, err := st.ListShares(ctx, "u1", true)
	if err != nil {
		t.Fatalf("ListShares(all): %v", err)
	}
	if len(all) != 2 {
		t.Errorf("all shares = %v, want 2", shareLabels(all))
	}

	byToken, err := st.ShareByToken(ctx, "tok-live")
	if err != nil {
		t.Fatalf("ShareByToken: %v", err)
	}
	if byToken.ID != live.ID {
		t.Errorf("ShareByToken returned %s, want %s", byToken.ID, live.ID)
	}

	forPlace, err := st.SharesForArrivePlace(ctx, "u1", "p_home")
	if err != nil {
		t.Fatalf("SharesForArrivePlace: %v", err)
	}
	if len(forPlace) != 1 {
		t.Fatalf("SharesForArrivePlace = %d, want 1", len(forPlace))
	}

	now := time.Now().UTC()
	revoked, err := st.RevokeShare(ctx, "u1", live.ID, "arrived at Home", now)
	if err != nil {
		t.Fatalf("RevokeShare: %v", err)
	}
	if revoked.RevokedAt == nil {
		t.Fatal("RevokedAt not set")
	}
	if !revoked.Active(now) == false {
		t.Error("revoked share still reports Active")
	}

	// Revoking twice keeps the original reason: a manual revoke racing an
	// auto-revoke must not rewrite the audit trail.
	again, err := st.RevokeShare(ctx, "u1", live.ID, "second reason", now.Add(time.Minute))
	if err != nil {
		t.Fatalf("RevokeShare(again): %v", err)
	}
	if again.RevokeReason != "arrived at Home" {
		t.Errorf("reason overwritten: %q", again.RevokeReason)
	}

	// After a revoke, the place lookup must not return it any more.
	forPlace, err = st.SharesForArrivePlace(ctx, "u1", "p_home")
	if err != nil {
		t.Fatalf("SharesForArrivePlace after revoke: %v", err)
	}
	if len(forPlace) != 0 {
		t.Errorf("revoked share still matched arrive place: %v", shareLabels(forPlace))
	}
}

func shareLabels(shares []domain.Share) []string {
	out := make([]string, 0, len(shares))
	for _, s := range shares {
		out = append(out, s.Label)
	}
	return out
}

// ---------------------------------------------------------------- channels

func testChannels(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")

	low, err := st.CreateChannel(ctx, domain.Channel{
		UserID: "u1", Type: "ntfy", Enabled: true, Priority: 5,
		Config: map[string]string{"topic": "lura-me"},
	})
	if err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	if _, err := st.CreateChannel(ctx, domain.Channel{
		UserID: "u1", Type: "log", Enabled: true, Priority: 50,
	}); err != nil {
		t.Fatalf("CreateChannel(log): %v", err)
	}

	list, err := st.ListChannels(ctx, "u1")
	if err != nil {
		t.Fatalf("ListChannels: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("got %d channels, want 2", len(list))
	}
	// Priority order matters: it is the failover order.
	if list[0].Type != "ntfy" {
		t.Errorf("channel order = %s first, want ntfy", list[0].Type)
	}
	if list[0].Config["topic"] != "lura-me" {
		t.Errorf("config round-trip failed: %v", list[0].Config)
	}

	low.Enabled = false
	if _, err := st.UpdateChannel(ctx, low); err != nil {
		t.Fatalf("UpdateChannel: %v", err)
	}
	list, _ = st.ListChannels(ctx, "u1")
	for _, c := range list {
		if c.ID == low.ID && c.Enabled {
			t.Error("channel not disabled")
		}
	}

	if err := st.DeleteChannel(ctx, "u1", low.ID); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	if err := st.DeleteChannel(ctx, "u1", low.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("second DeleteChannel = %v, want ErrNotFound", err)
	}
}

// ---------------------------------------------------------------- events

func testTriggerEvents(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPlace(t, st, "u1", "p1", "Home", 12.9611, 77.6387, 120)

	base := time.Now().UTC()
	for i := 0; i < 3; i++ {
		if _, err := st.InsertTriggerEvent(ctx, domain.TriggerEvent{
			UserID: "u1", PlaceID: "p1", PlaceName: "Home", DeviceID: "d1",
			Trigger: domain.TriggerArrive, TS: base.Add(time.Duration(i) * time.Minute),
			NoteIDs: []string{"n1"}, Delivered: []string{"inapp"},
		}); err != nil {
			t.Fatalf("InsertTriggerEvent: %v", err)
		}
	}

	events, err := st.ListTriggerEvents(ctx, "u1", 10)
	if err != nil {
		t.Fatalf("ListTriggerEvents: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("got %d events, want 3", len(events))
	}
	// Newest first: the UI shows a feed.
	if events[0].TS.Before(events[1].TS) {
		t.Error("events are not newest-first")
	}
	if len(events[0].Delivered) != 1 || events[0].Delivered[0] != "inapp" {
		t.Errorf("delivered = %v", events[0].Delivered)
	}

	limited, err := st.ListTriggerEvents(ctx, "u1", 2)
	if err != nil {
		t.Fatalf("ListTriggerEvents(limit): %v", err)
	}
	if len(limited) != 2 {
		t.Errorf("limit returned %d, want 2", len(limited))
	}
}

// ---------------------------------------------------------------- dwells

func testPendingDwells(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustDevice(t, st, "u1", "d1")
	mustPlace(t, st, "u1", "p_gym", "Gym", 12.9668, 77.6290, 80, domain.TriggerDwell)

	entered := time.Now().UTC().Add(-10 * time.Minute)
	pd := domain.PendingDwell{
		DeviceID: "d1", UserID: "u1", PlaceID: "p_gym",
		EnteredAt: entered, FireAt: entered.Add(45 * time.Minute),
	}
	if err := st.PutPendingDwell(ctx, pd); err != nil {
		t.Fatalf("PutPendingDwell: %v", err)
	}

	// Not due yet.
	due, err := st.DuePendingDwells(ctx, time.Now().UTC())
	if err != nil {
		t.Fatalf("DuePendingDwells: %v", err)
	}
	if len(due) != 0 {
		t.Errorf("timer fired early: %+v", due)
	}

	// Due once the clock passes FireAt.
	due, err = st.DuePendingDwells(ctx, pd.FireAt.Add(time.Second))
	if err != nil {
		t.Fatalf("DuePendingDwells(after): %v", err)
	}
	if len(due) != 1 {
		t.Fatalf("got %d due timers, want 1", len(due))
	}

	// Re-arming keeps entered_at: dwell measures time at the place, not time
	// since we last looked.
	pd2 := pd
	pd2.FireAt = pd.FireAt.Add(time.Hour)
	pd2.EnteredAt = time.Now().UTC()
	if err := st.PutPendingDwell(ctx, pd2); err != nil {
		t.Fatalf("PutPendingDwell(rearm): %v", err)
	}
	listed, err := st.ListPendingDwells(ctx, "u1")
	if err != nil {
		t.Fatalf("ListPendingDwells: %v", err)
	}
	if len(listed) != 1 {
		t.Fatalf("got %d timers, want 1 (re-arm must not duplicate)", len(listed))
	}
	if !listed[0].EnteredAt.Truncate(time.Millisecond).Equal(entered.Truncate(time.Millisecond)) {
		t.Errorf("entered_at changed on re-arm: %v, want %v", listed[0].EnteredAt, entered)
	}

	if err := st.DeletePendingDwell(ctx, "d1", "p_gym"); err != nil {
		t.Fatalf("DeletePendingDwell: %v", err)
	}
	listed, _ = st.ListPendingDwells(ctx, "u1")
	if len(listed) != 0 {
		t.Errorf("timer survived cancellation: %+v", listed)
	}
}

// ---------------------------------------------------------------- isolation

// testUserScoping asserts HLD §11: per-user isolation is enforced in the query,
// so one user can never read or mutate another's rows.
func testUserScoping(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "alice")
	mustUser(t, st, "bob")
	mustDevice(t, st, "alice", "d_alice")
	place := mustPlace(t, st, "alice", "p_alice", "Alice Home", 12.9611, 77.6387, 120)
	note, err := st.CreateNote(ctx, domain.Note{
		UserID: "alice", Text: "secret", PlaceID: place.ID, Trigger: domain.TriggerArrive,
	})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if _, err := st.GetPlace(ctx, "bob", place.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("bob read alice's place: %v", err)
	}
	if _, err := st.GetNote(ctx, "bob", note.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("bob read alice's note: %v", err)
	}
	if _, err := st.GetDevice(ctx, "bob", "d_alice"); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("bob read alice's device: %v", err)
	}
	if err := st.DeletePlace(ctx, "bob", place.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("bob deleted alice's place: %v", err)
	}
	if _, err := st.UpdateNote(ctx, domain.Note{
		ID: note.ID, UserID: "bob", Text: "hijacked", Trigger: domain.TriggerArrive,
	}); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("bob updated alice's note: %v", err)
	}

	// Alice's data is untouched.
	got, err := st.GetNote(ctx, "alice", note.ID)
	if err != nil || got.Text != "secret" {
		t.Errorf("alice's note damaged: %+v, %v", got, err)
	}

	// Listings are scoped too.
	if places, err := st.ListPlaces(ctx, "bob"); err != nil || len(places) != 0 {
		t.Errorf("bob's place list = %v, %v; want empty", names(places), err)
	}
	if notes, err := st.ListNotes(ctx, "bob", store.NoteFilter{}); err != nil || len(notes) != 0 {
		t.Errorf("bob's note list = %v, %v; want empty", texts(notes), err)
	}
}

func testPlaceStats(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustPlace(t, st, "u1", "p1", "Home", 12.9611, 77.6387, 120)
	mustPlace(t, st, "u1", "p2", "Gym", 12.9668, 77.6290, 80)

	for i := 0; i < 2; i++ {
		if _, err := st.CreateNote(ctx, domain.Note{
			UserID: "u1", Text: "n", PlaceID: "p1", Trigger: domain.TriggerArrive,
		}); err != nil {
			t.Fatalf("CreateNote: %v", err)
		}
	}
	if _, err := st.InsertTriggerEvent(ctx, domain.TriggerEvent{
		UserID: "u1", PlaceID: "p1", Trigger: domain.TriggerArrive, TS: time.Now().UTC(),
	}); err != nil {
		t.Fatalf("InsertTriggerEvent: %v", err)
	}

	stats, err := st.PlaceStats(ctx, "u1")
	if err != nil {
		t.Fatalf("PlaceStats: %v", err)
	}
	if stats["p1"].Notes != 2 || stats["p1"].Events != 1 {
		t.Errorf("p1 stats = %+v, want {Notes:2 Events:1}", stats["p1"])
	}
	if stats["p2"].Notes != 0 || stats["p2"].Events != 0 {
		t.Errorf("p2 stats = %+v, want zeroes", stats["p2"])
	}
}
