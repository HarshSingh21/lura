package history_test

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

const (
	user   = "u1"
	device = "d1"
)

var (
	home   = domain.Point{Lat: 12.9611, Lon: 77.6387}
	office = domain.Point{Lat: 12.9784, Lon: 77.6408}
)

// fixture builds a store with two places and a device.
func fixture(t *testing.T) *memory.Store {
	t.Helper()
	ctx := context.Background()
	st := memory.New()
	if err := st.UpsertUser(ctx, domain.User{ID: user, TZ: "UTC"}); err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	if err := st.UpsertDevice(ctx, domain.Device{ID: device, UserID: user, Name: "Phone", Token: "tok"}); err != nil {
		t.Fatalf("UpsertDevice: %v", err)
	}
	for _, p := range []domain.Place{
		{ID: "plc_home", UserID: user, Name: "Home", Center: home, RadiusM: 120,
			Triggers: []domain.Trigger{domain.TriggerArrive}},
		{ID: "plc_office", UserID: user, Name: "Office", Center: office, RadiusM: 200,
			Triggers: []domain.Trigger{domain.TriggerArrive}},
	} {
		if _, err := st.CreatePlace(ctx, p); err != nil {
			t.Fatalf("CreatePlace: %v", err)
		}
	}
	return st
}

// track is a small builder for a synthetic day.
type track struct {
	t      *testing.T
	st     *memory.Store
	cursor time.Time
	fixes  []domain.Position
}

func newTrack(t *testing.T, st *memory.Store, start time.Time) *track {
	return &track{t: t, st: st, cursor: start}
}

// stay emits stationary fixes for d.
func (tr *track) stay(at domain.Point, d, every time.Duration) *track {
	for elapsed := time.Duration(0); elapsed <= d; elapsed += every {
		tr.emit(at, 0)
		tr.cursor = tr.cursor.Add(every)
	}
	return tr
}

// drive emits fixes travelling from → to at speed.
func (tr *track) drive(from, to domain.Point, speedMPS float64, every time.Duration) *track {
	dist := geo.DistanceM(from.Lat, from.Lon, to.Lat, to.Lon)
	bearing := geo.BearingDeg(from.Lat, from.Lon, to.Lat, to.Lon)
	steps := int(math.Ceil(dist / (speedMPS * every.Seconds())))
	if steps < 1 {
		steps = 1
	}
	for i := 1; i <= steps; i++ {
		lat, lon := geo.Destination(from.Lat, from.Lon, bearing, dist*float64(i)/float64(steps))
		tr.emit(domain.Point{Lat: lat, Lon: lon}, speedMPS)
		tr.cursor = tr.cursor.Add(every)
	}
	return tr
}

func (tr *track) emit(pt domain.Point, speed float64) {
	tr.fixes = append(tr.fixes, domain.Position{
		DeviceID: device, UserID: user,
		RecvTS: tr.cursor, DeviceTS: tr.cursor,
		Point: pt, SpeedMPS: speed, AccuracyM: 6,
	})
}

func (tr *track) commit() {
	tr.t.Helper()
	if _, err := tr.st.InsertPositions(context.Background(), tr.fixes); err != nil {
		tr.t.Fatalf("InsertPositions: %v", err)
	}
}

func summarise(t *testing.T, st *memory.Store, from, to time.Time) history.Summary {
	t.Helper()
	sum, err := history.New(st, nil, history.Config{}).
		Summarise(context.Background(), user, history.Query{DeviceID: device, From: from, To: to})
	if err != nil {
		t.Fatalf("Summarise: %v", err)
	}
	return sum
}

// A day of home → office → home must come out as stop, drive, stop, drive, stop,
// with the right place labels: that is the timeline the History view renders.
func TestSegmentsStopsAndDrives(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 20*time.Minute, 5*time.Minute)
	tr.drive(home, office, 11, 30*time.Second)
	tr.stay(office, 4*time.Hour, 5*time.Minute)
	tr.drive(office, home, 11, 30*time.Second)
	tr.stay(home, 30*time.Minute, 5*time.Minute)
	tr.commit()

	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))

	if sum.Trips != 2 {
		t.Errorf("trips = %d, want 2", sum.Trips)
	}
	if sum.Stops != 3 {
		t.Errorf("stops = %d, want 3", sum.Stops)
	}

	kinds := make([]string, 0, len(sum.Segments))
	for _, s := range sum.Segments {
		kinds = append(kinds, s.Kind)
	}
	wantKinds := []string{"stop", "move", "stop", "move", "stop"}
	if strings.Join(kinds, ",") != strings.Join(wantKinds, ",") {
		t.Fatalf("segment kinds = %v, want %v", kinds, wantKinds)
	}

	if sum.Segments[0].AtPlace != "Home" {
		t.Errorf("first stop at %q, want Home", sum.Segments[0].AtPlace)
	}
	if sum.Segments[1].FromPlace != "Home" || sum.Segments[1].ToPlace != "Office" {
		t.Errorf("first trip %q → %q, want Home → Office",
			sum.Segments[1].FromPlace, sum.Segments[1].ToPlace)
	}
	if sum.Segments[2].AtPlace != "Office" {
		t.Errorf("middle stop at %q, want Office", sum.Segments[2].AtPlace)
	}

	// Distance should be roughly twice the one-way distance.
	oneWay := geo.DistanceM(home.Lat, home.Lon, office.Lat, office.Lon)
	if sum.DistanceM < oneWay*1.8 || sum.DistanceM > oneWay*2.2 {
		t.Errorf("total distance = %.0f m, want ≈ %.0f m", sum.DistanceM, oneWay*2)
	}
}

// A pause at a traffic light must not chop one drive into three.
func TestShortStopsAreAbsorbedIntoTheDrive(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 9, 0, 0, 0, time.UTC)

	mid := domain.Point{
		Lat: (home.Lat + office.Lat) / 2,
		Lon: (home.Lon + office.Lon) / 2,
	}

	tr := newTrack(t, st, start)
	tr.drive(home, mid, 11, 30*time.Second)
	tr.stay(mid, 60*time.Second, 30*time.Second) // red light, under StopMinDuration
	tr.drive(mid, office, 11, 30*time.Second)
	tr.stay(office, 30*time.Minute, 5*time.Minute)
	tr.commit()

	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
	if sum.Trips != 1 {
		t.Errorf("trips = %d, want 1 (a light should not split the drive)", sum.Trips)
	}
	if sum.Stops != 1 {
		t.Errorf("stops = %d, want 1 (only the office)", sum.Stops)
	}
}

// Mode classification: walking pace is a walk, city driving is a drive.
func TestModeClassification(t *testing.T) {
	cases := []struct {
		name  string
		speed float64
		want  string
	}{
		{"walk", 1.3, "Walk"},
		{"cycle", 5.0, "Cycle"},
		{"drive", 13.0, "Drive"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			st := fixture(t)
			start := time.Date(2026, 3, 2, 10, 0, 0, 0, time.UTC)

			// A destination far enough that every mode covers > MinMoveDistanceM.
			dest, _ := destAlong(home, 45, 1500)
			tr := newTrack(t, st, start)
			tr.stay(home, 10*time.Minute, 5*time.Minute)
			tr.drive(home, dest, tc.speed, 20*time.Second)
			tr.stay(dest, 10*time.Minute, 5*time.Minute)
			tr.commit()

			sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
			var mode string
			for _, s := range sum.Segments {
				if s.Kind == "move" {
					mode = s.Mode
				}
			}
			if mode != tc.want {
				t.Errorf("mode = %q, want %q", mode, tc.want)
			}
		})
	}
}

// A single impossible jump (bad fix or spoofed location) must not claim a
// hundred-kilometre trip.
func TestImpossibleJumpIsRejected(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 11, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 15*time.Minute, 5*time.Minute)
	// One fix from 500 km away, ten seconds later.
	tr.emit(domain.Point{Lat: 17.3850, Lon: 78.4867}, 0)
	tr.cursor = tr.cursor.Add(10 * time.Second)
	tr.stay(home, 15*time.Minute, 5*time.Minute)
	tr.commit()

	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
	if sum.DistanceM > 1000 {
		t.Errorf("distance = %.0f m: an impossible jump was counted", sum.DistanceM)
	}
	if sum.Trips != 0 {
		t.Errorf("trips = %d, want 0", sum.Trips)
	}
}

// A long silence (phone off, tunnel) splits segments rather than inventing a
// straight line through it.
func TestGapSplitsSegments(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 12, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 20*time.Minute, 5*time.Minute)
	tr.cursor = tr.cursor.Add(2 * time.Hour) // phone off
	tr.stay(office, 20*time.Minute, 5*time.Minute)
	tr.commit()

	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
	if sum.Stops != 2 {
		t.Errorf("stops = %d, want 2 (the gap must split them)", sum.Stops)
	}
	if sum.Trips != 0 {
		t.Errorf("trips = %d, want 0 (we do not know how they travelled)", sum.Trips)
	}
}

func TestEmptyWindowIsNotAnError(t *testing.T) {
	st := fixture(t)
	now := time.Now().UTC()
	sum := summarise(t, st, now.Add(-time.Hour), now)
	if len(sum.Segments) != 0 || sum.Points != 0 {
		t.Errorf("empty window produced %d segments / %d points", len(sum.Segments), sum.Points)
	}
	// It must still export cleanly: an empty day is a valid GeoJSON document.
	body, err := history.New(st, nil, history.Config{}).GeoJSON(sum)
	if err != nil {
		t.Fatalf("GeoJSON: %v", err)
	}
	var fc struct {
		Type     string `json:"type"`
		Features []any  `json:"features"`
	}
	if err := json.Unmarshal(body, &fc); err != nil {
		t.Fatalf("GeoJSON is not valid JSON: %v", err)
	}
	if fc.Type != "FeatureCollection" || len(fc.Features) != 0 {
		t.Errorf("GeoJSON = %+v", fc)
	}
}

// ---------------------------------------------------------------- exports

func TestGeoJSONExport(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 20*time.Minute, 5*time.Minute)
	tr.drive(home, office, 11, 30*time.Second)
	tr.stay(office, 40*time.Minute, 5*time.Minute)
	tr.commit()

	svc := history.New(st, nil, history.Config{})
	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
	body, err := svc.GeoJSON(sum)
	if err != nil {
		t.Fatalf("GeoJSON: %v", err)
	}

	var fc struct {
		Type     string `json:"type"`
		Features []struct {
			Geometry struct {
				Type        string          `json:"type"`
				Coordinates json.RawMessage `json:"coordinates"`
			} `json:"geometry"`
			Properties map[string]any `json:"properties"`
		} `json:"features"`
	}
	if err := json.Unmarshal(body, &fc); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if fc.Type != "FeatureCollection" {
		t.Errorf("type = %q", fc.Type)
	}
	if len(fc.Features) != 3 {
		t.Fatalf("features = %d, want 3", len(fc.Features))
	}

	var points, lines int
	for _, f := range fc.Features {
		switch f.Geometry.Type {
		case "Point":
			points++
		case "LineString":
			lines++
			// GeoJSON is lon,lat — the classic axis-order bug. Bengaluru is
			// lon ≈ 77, lat ≈ 13, so the first value must be the larger one.
			var coords [][]float64
			if err := json.Unmarshal(f.Geometry.Coordinates, &coords); err != nil {
				t.Fatalf("coordinates: %v", err)
			}
			if len(coords) == 0 {
				t.Fatal("empty LineString")
			}
			if coords[0][0] < coords[0][1] {
				t.Errorf("coordinates look like lat,lon: %v (GeoJSON wants lon,lat)", coords[0])
			}
		}
	}
	if points != 2 || lines != 1 {
		t.Errorf("got %d points and %d lines, want 2 and 1", points, lines)
	}
}

func TestGPXExport(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 20*time.Minute, 5*time.Minute)
	tr.drive(home, office, 11, 30*time.Second)
	tr.stay(office, 40*time.Minute, 5*time.Minute)
	tr.commit()

	svc := history.New(st, nil, history.Config{})
	sum := summarise(t, st, start.Add(-time.Hour), tr.cursor.Add(time.Hour))
	body, err := svc.GPX(sum)
	if err != nil {
		t.Fatalf("GPX: %v", err)
	}

	if !strings.HasPrefix(string(body), xml.Header) {
		t.Error("GPX is missing the XML declaration")
	}

	var doc struct {
		Version string `xml:"version,attr"`
		Wpts    []struct {
			Lat  float64 `xml:"lat,attr"`
			Lon  float64 `xml:"lon,attr"`
			Name string  `xml:"name"`
		} `xml:"wpt"`
		Trks []struct {
			Name string `xml:"name"`
			Segs []struct {
				Pts []struct {
					Lat float64 `xml:"lat,attr"`
					Lon float64 `xml:"lon,attr"`
				} `xml:"trkpt"`
			} `xml:"trkseg"`
		} `xml:"trk"`
	}
	if err := xml.Unmarshal(body, &doc); err != nil {
		t.Fatalf("GPX does not parse: %v", err)
	}
	if doc.Version != "1.1" {
		t.Errorf("version = %q, want 1.1", doc.Version)
	}
	if len(doc.Wpts) != 2 {
		t.Errorf("waypoints = %d, want 2 (one per stop)", len(doc.Wpts))
	}
	if len(doc.Trks) != 1 {
		t.Fatalf("tracks = %d, want 1", len(doc.Trks))
	}
	if len(doc.Trks[0].Segs) != 1 || len(doc.Trks[0].Segs[0].Pts) < 2 {
		t.Errorf("track has no usable segment: %+v", doc.Trks[0])
	}
	if doc.Wpts[0].Lat < 12 || doc.Wpts[0].Lat > 14 {
		t.Errorf("waypoint latitude looks wrong: %v", doc.Wpts[0].Lat)
	}
}

// ---------------------------------------------------------------- filters, retention

func TestPlaceFilter(t *testing.T) {
	st := fixture(t)
	start := time.Date(2026, 3, 2, 8, 0, 0, 0, time.UTC)

	tr := newTrack(t, st, start)
	tr.stay(home, 20*time.Minute, 5*time.Minute)
	tr.drive(home, office, 11, 30*time.Second)
	tr.stay(office, 40*time.Minute, 5*time.Minute)
	tr.commit()

	svc := history.New(st, nil, history.Config{})
	sum, err := svc.Summarise(context.Background(), user, history.Query{
		DeviceID: device, From: start.Add(-time.Hour), To: tr.cursor.Add(time.Hour),
		PlaceID: "plc_office",
	})
	if err != nil {
		t.Fatalf("Summarise: %v", err)
	}
	if len(sum.Segments) == 0 {
		t.Fatal("place filter removed everything")
	}
	for _, s := range sum.Segments {
		if s.AtPlace != "Office" && s.FromPlace != "Office" && s.ToPlace != "Office" {
			t.Errorf("segment unrelated to the filtered place: %+v", s)
		}
	}
}

func TestRetentionDeletesOldFixesOnly(t *testing.T) {
	st := fixture(t)
	ctx := context.Background()
	now := time.Now().UTC()

	old := domain.Position{DeviceID: device, UserID: user,
		RecvTS: now.AddDate(0, 0, -120), DeviceTS: now.AddDate(0, 0, -120), Point: home}
	recent := domain.Position{DeviceID: device, UserID: user,
		RecvTS: now.Add(-time.Hour), DeviceTS: now.Add(-time.Hour), Point: home}
	if _, err := st.InsertPositions(ctx, []domain.Position{old, recent}); err != nil {
		t.Fatalf("InsertPositions: %v", err)
	}

	svc := history.New(st, nil, history.Config{})
	deleted, err := svc.Retain(ctx, user, 90)
	if err != nil {
		t.Fatalf("Retain: %v", err)
	}
	if deleted != 1 {
		t.Errorf("deleted %d rows, want 1", deleted)
	}

	rows, err := st.ListPositions(ctx, user, store.PositionQuery{DeviceID: device})
	if err != nil {
		t.Fatalf("ListPositions: %v", err)
	}
	if len(rows) != 1 || !rows[0].RecvTS.Equal(recent.RecvTS) {
		t.Errorf("retention kept the wrong rows: %+v", rows)
	}

	// Retention disabled must be a no-op, not a wipe.
	if n, err := svc.Retain(ctx, user, 0); err != nil || n != 0 {
		t.Errorf("Retain(0) = %d, %v; want 0, nil", n, err)
	}
}

func TestInvertedWindowIsRejected(t *testing.T) {
	st := fixture(t)
	now := time.Now().UTC()
	_, err := history.New(st, nil, history.Config{}).Summarise(context.Background(), user, history.Query{
		DeviceID: device, From: now, To: now.Add(-time.Hour),
	})
	if err == nil {
		t.Error("an inverted window was accepted")
	}
}

func destAlong(from domain.Point, bearing, metres float64) (domain.Point, float64) {
	lat, lon := geo.Destination(from.Lat, from.Lon, bearing, metres)
	return domain.Point{Lat: lat, Lon: lon}, metres
}
