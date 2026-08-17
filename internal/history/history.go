// Package history derives trips and stops from the raw position stream and
// exports them.
//
// HLD §5.9: query the hypertable, segment by speed/gap heuristics into a
// drive/walk/stop list, search by place and time, export GeoJSON/GPX, and honour
// retention. Segmentation is derived on read rather than materialised on write —
// the heuristics are still being tuned (HLD §17 lists history retention and
// route source as open questions), and a stored segmentation would have to be
// rebuilt every time a threshold changes.
package history

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"fmt"
	"log/slog"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Config holds the segmentation heuristics.
type Config struct {
	// StopSpeedMPS and below counts as stationary.
	StopSpeedMPS float64
	// StopMinDuration is how long stationary must last to be a real stop; below
	// this it is a traffic light, not a visit.
	StopMinDuration time.Duration
	// GapSplit: a silence longer than this splits segments, because we do not
	// know what happened in between (phone off, tunnel, battery dead).
	GapSplit time.Duration
	// Mode thresholds on a segment's average speed.
	WalkMaxMPS  float64
	CycleMaxMPS float64
	// MinMoveDistanceM discards movements that are only GPS jitter.
	MinMoveDistanceM float64
	// MaxJumpMPS rejects physically impossible speeds between two fixes
	// (bad fix, spoofed location) so one outlier cannot claim a 900 km trip.
	MaxJumpMPS float64
}

// DefaultConfig returns tuned-but-conservative heuristics.
func DefaultConfig() Config {
	return Config{
		StopSpeedMPS:     0.7, // slower than a slow walk
		StopMinDuration:  3 * time.Minute,
		GapSplit:         10 * time.Minute,
		WalkMaxMPS:       2.2, // ~8 km/h
		CycleMaxMPS:      7.0, // ~25 km/h
		MinMoveDistanceM: 60,  // below a typical GPS wander over minutes
		MaxJumpMPS:       340, // speed of sound: beyond this it is a bad fix
	}
}

func (c Config) withDefaults() Config {
	d := DefaultConfig()
	if c.StopSpeedMPS <= 0 {
		c.StopSpeedMPS = d.StopSpeedMPS
	}
	if c.StopMinDuration <= 0 {
		c.StopMinDuration = d.StopMinDuration
	}
	if c.GapSplit <= 0 {
		c.GapSplit = d.GapSplit
	}
	if c.WalkMaxMPS <= 0 {
		c.WalkMaxMPS = d.WalkMaxMPS
	}
	if c.CycleMaxMPS <= 0 {
		c.CycleMaxMPS = d.CycleMaxMPS
	}
	if c.MinMoveDistanceM <= 0 {
		c.MinMoveDistanceM = d.MinMoveDistanceM
	}
	if c.MaxJumpMPS <= 0 {
		c.MaxJumpMPS = d.MaxJumpMPS
	}
	return c
}

// Summary is a device's day: the segments plus the totals the UI header shows.
type Summary struct {
	DeviceID  string           `json:"deviceId"`
	From      time.Time        `json:"from"`
	To        time.Time        `json:"to"`
	DistanceM float64          `json:"distanceM"`
	Trips     int              `json:"trips"`
	Stops     int              `json:"stops"`
	MovingFor time.Duration    `json:"-"`
	MovingSec float64          `json:"movingSeconds"`
	Segments  []domain.Segment `json:"segments"`
	Track     []domain.Point   `json:"track"`
	Points    int              `json:"points"`
}

// Service answers history queries.
type Service struct {
	store store.Store
	log   *slog.Logger
	cfg   Config
}

// New returns a history service.
func New(st store.Store, log *slog.Logger, cfg Config) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{store: st, log: log, cfg: cfg.withDefaults()}
}

// Query selects what to summarise.
type Query struct {
	DeviceID string
	From     time.Time
	To       time.Time
	PlaceID  string // when set, only segments touching this place are returned
	Limit    int
}

// Summarise loads positions and segments them.
func (s *Service) Summarise(ctx context.Context, userID string, q Query) (Summary, error) {
	ctx, span := obs.Start(ctx, "history.summarise")
	defer span.End()

	if q.To.IsZero() {
		q.To = time.Now().UTC()
	}
	if q.From.IsZero() {
		q.From = q.To.Add(-24 * time.Hour)
	}
	if q.From.After(q.To) {
		return Summary{}, fmt.Errorf("history: from after to: %w", domain.ErrInvalid)
	}

	positions, err := s.store.ListPositions(ctx, userID, store.PositionQuery{
		DeviceID: q.DeviceID,
		From:     q.From,
		To:       q.To,
		Limit:    q.Limit,
	})
	if err != nil {
		return Summary{}, err
	}

	places, err := s.store.ListPlaces(ctx, userID)
	if err != nil {
		return Summary{}, err
	}

	sum := s.segment(positions, places)
	sum.DeviceID = q.DeviceID
	sum.From, sum.To = q.From, q.To

	if q.PlaceID != "" {
		sum.Segments = filterByPlace(sum.Segments, placeName(places, q.PlaceID))
	}
	return sum, nil
}

// segment is the heuristic core, kept pure (positions in, summary out) so it can
// be tested without a store and tuned against recorded traces.
func (s *Service) segment(positions []domain.Position, places []domain.Place) Summary {
	sum := Summary{Segments: []domain.Segment{}, Track: []domain.Point{}, Points: len(positions)}
	if len(positions) == 0 {
		return sum
	}
	sort.SliceStable(positions, func(i, j int) bool { return positions[i].RecvTS.Before(positions[j].RecvTS) })

	// ---- pass 1: per-point speed and outlier rejection.
	samples := make([]sample, 0, len(positions))
	for i, p := range positions {
		sm := sample{pos: p, speed: p.SpeedMPS}
		if i > 0 {
			prev := positions[i-1]
			sm.gap = p.RecvTS.Sub(prev.RecvTS)
			sm.distM = geo.DistanceM(prev.Point.Lat, prev.Point.Lon, p.Point.Lat, p.Point.Lon)
			if sm.gap > 0 {
				derived := sm.distM / sm.gap.Seconds()
				if derived > s.cfg.MaxJumpMPS {
					// Impossible jump: drop the fix rather than let it distort
					// both the distance total and the mode classification.
					continue
				}
				// Prefer the device's own speed when it reported one; fall back to
				// the derived speed, which is all an OwnTracks client may give us.
				if sm.speed == 0 {
					sm.speed = derived
				}
			}
		}
		samples = append(samples, sm)
	}
	if len(samples) == 0 {
		return sum
	}

	for _, sm := range samples {
		sum.Track = append(sum.Track, sm.pos.Point)
	}

	// ---- pass 2: runs of moving / stationary, split on long gaps.
	type run struct {
		moving  bool
		samples []sample
	}
	var runs []run
	cur := run{moving: samples[0].speed > s.cfg.StopSpeedMPS, samples: []sample{samples[0]}}
	for _, sm := range samples[1:] {
		moving := sm.speed > s.cfg.StopSpeedMPS
		if sm.gap > s.cfg.GapSplit || moving != cur.moving {
			runs = append(runs, cur)
			cur = run{moving: moving, samples: []sample{sm}}
			continue
		}
		cur.samples = append(cur.samples, sm)
	}
	runs = append(runs, cur)

	// ---- pass 3: absorb stationary runs that are too short to be stops. A car
	// waiting at a light must not chop one drive into three.
	merged := make([]run, 0, len(runs))
	for _, r := range runs {
		dur := runDuration(r.samples)
		if !r.moving && dur < s.cfg.StopMinDuration && len(merged) > 0 && merged[len(merged)-1].moving {
			last := &merged[len(merged)-1]
			last.samples = append(last.samples, r.samples...)
			continue
		}
		// Having absorbed a pause into the preceding drive, the movement that
		// follows it belongs to that same drive: otherwise one red light turns a
		// commute into two trips.
		if r.moving && len(merged) > 0 && merged[len(merged)-1].moving {
			last := &merged[len(merged)-1]
			last.samples = append(last.samples, r.samples...)
			continue
		}
		merged = append(merged, r)
	}

	// ---- pass 4: runs → segments.
	for _, r := range merged {
		if len(r.samples) == 0 {
			continue
		}
		seg := domain.Segment{
			ID:       idgen.New("seg"),
			DeviceID: r.samples[0].pos.DeviceID,
			StartTS:  r.samples[0].pos.RecvTS,
			EndTS:    r.samples[len(r.samples)-1].pos.RecvTS,
		}
		for i, sm := range r.samples {
			seg.Path = append(seg.Path, sm.pos.Point)
			// distM is measured from the *previous fix in the whole series*, so the
			// first sample of a movement carries the hop out of the preceding stop.
			// Counting it is what makes the day's total match the ground truth;
			// skipping it under-reports every leg by one hop. The exception is a
			// sample that opens a run because of a long silence — we do not know
			// how that ground was covered, so it is not counted as travelled.
			if i == 0 && (sm.gap > s.cfg.GapSplit || sm.gap == 0) {
				continue
			}
			seg.DistanceM += sm.distM
		}

		if r.moving {
			seg.Kind = "move"
			seg.Mode = s.modeFor(seg)
			seg.FromPlace = nearestPlaceName(places, seg.Path[0])
			seg.ToPlace = nearestPlaceName(places, seg.Path[len(seg.Path)-1])
			if seg.DistanceM < s.cfg.MinMoveDistanceM {
				continue // jitter, not a trip
			}
			sum.Trips++
			sum.DistanceM += seg.DistanceM
			sum.MovingFor += seg.Duration()
		} else {
			seg.Kind = "stop"
			seg.Mode = "Stop"
			seg.AtPlace = nearestPlaceName(places, centroid(seg.Path))
			if seg.Duration() < s.cfg.StopMinDuration {
				continue // a pause at the start or end of the window
			}
			sum.Stops++
		}
		sum.Segments = append(sum.Segments, seg)
	}

	// Fill each trip's endpoints from the stops around it: "Office → Whole Foods"
	// reads better than "unknown → unknown" when the endpoint sits just outside a
	// geofence radius.
	for i := range sum.Segments {
		if sum.Segments[i].Kind != "move" {
			continue
		}
		if sum.Segments[i].FromPlace == "" && i > 0 && sum.Segments[i-1].Kind == "stop" {
			sum.Segments[i].FromPlace = sum.Segments[i-1].AtPlace
		}
		if sum.Segments[i].ToPlace == "" && i+1 < len(sum.Segments) && sum.Segments[i+1].Kind == "stop" {
			sum.Segments[i].ToPlace = sum.Segments[i+1].AtPlace
		}
	}

	sum.MovingSec = sum.MovingFor.Seconds()
	return sum
}

// modeFor classifies a movement. It uses the 85th-percentile speed rather than
// the mean, because a drive that spends half its time in traffic is still a
// drive.
func (s *Service) modeFor(seg domain.Segment) string {
	dur := seg.Duration().Seconds()
	if dur <= 0 {
		return "Drive"
	}
	avg := seg.DistanceM / dur
	switch {
	case avg <= s.cfg.WalkMaxMPS:
		return "Walk"
	case avg <= s.cfg.CycleMaxMPS:
		return "Cycle"
	default:
		return "Drive"
	}
}

// Retain deletes positions older than the retention window and reports how many
// rows went. Data rights (HLD §11) mean this has to be a first-class operation,
// not a DBA's cron job.
func (s *Service) Retain(ctx context.Context, userID string, days int) (int, error) {
	if days <= 0 {
		return 0, nil // retention disabled: keep everything
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -days)
	n, err := s.store.DeletePositionsBefore(ctx, userID, cutoff)
	if err != nil {
		return 0, err
	}
	if n > 0 {
		s.log.InfoContext(ctx, "history: retention sweep", "deleted", n, "before", cutoff)
	}
	return n, nil
}

// ---------------------------------------------------------------- exports

// GeoJSON renders a summary as a FeatureCollection: a LineString per trip and a
// Point per stop.
func (s *Service) GeoJSON(sum Summary) ([]byte, error) {
	type feature struct {
		Type       string         `json:"type"`
		Geometry   map[string]any `json:"geometry"`
		Properties map[string]any `json:"properties"`
	}
	fc := struct {
		Type     string    `json:"type"`
		Features []feature `json:"features"`
	}{Type: "FeatureCollection", Features: []feature{}}

	for _, seg := range sum.Segments {
		props := map[string]any{
			"id":        seg.ID,
			"kind":      seg.Kind,
			"mode":      seg.Mode,
			"start":     seg.StartTS.UTC().Format(time.RFC3339),
			"end":       seg.EndTS.UTC().Format(time.RFC3339),
			"durationS": seg.Duration().Seconds(),
			"distanceM": math.Round(seg.DistanceM),
			"deviceId":  seg.DeviceID,
		}
		if seg.Kind == "stop" {
			if seg.AtPlace != "" {
				props["place"] = seg.AtPlace
			}
			c := centroid(seg.Path)
			fc.Features = append(fc.Features, feature{
				Type:       "Feature",
				Geometry:   map[string]any{"type": "Point", "coordinates": []float64{c.Lon, c.Lat}},
				Properties: props,
			})
			continue
		}
		if seg.FromPlace != "" {
			props["from"] = seg.FromPlace
		}
		if seg.ToPlace != "" {
			props["to"] = seg.ToPlace
		}
		coords := make([][]float64, 0, len(seg.Path))
		for _, p := range seg.Path {
			coords = append(coords, []float64{p.Lon, p.Lat}) // GeoJSON is lon,lat
		}
		fc.Features = append(fc.Features, feature{
			Type:       "Feature",
			Geometry:   map[string]any{"type": "LineString", "coordinates": coords},
			Properties: props,
		})
	}
	return json.MarshalIndent(fc, "", "  ")
}

// gpx mirrors the GPX 1.1 schema closely enough for every consumer that matters
// (Strava, OsmAnd, GPSBabel) without pulling in a dependency.
type gpx struct {
	XMLName xml.Name `xml:"gpx"`
	Version string   `xml:"version,attr"`
	Creator string   `xml:"creator,attr"`
	NS      string   `xml:"xmlns,attr"`
	Meta    gpxMeta  `xml:"metadata"`
	Wpts    []gpxWpt `xml:"wpt"`
	Trks    []gpxTrk `xml:"trk"`
}

type gpxMeta struct {
	Name string `xml:"name"`
	Time string `xml:"time"`
}

type gpxWpt struct {
	Lat  float64 `xml:"lat,attr"`
	Lon  float64 `xml:"lon,attr"`
	Name string  `xml:"name,omitempty"`
	Time string  `xml:"time,omitempty"`
	Desc string  `xml:"desc,omitempty"`
}

type gpxTrk struct {
	Name string      `xml:"name"`
	Type string      `xml:"type,omitempty"`
	Segs []gpxTrkseg `xml:"trkseg"`
}

type gpxTrkseg struct {
	Pts []gpxWpt `xml:"trkpt"`
}

// GPX renders a summary as a GPX 1.1 document.
func (s *Service) GPX(sum Summary) ([]byte, error) {
	doc := gpx{
		Version: "1.1",
		Creator: "Lura",
		NS:      "http://www.topografix.com/GPX/1/1",
		Meta: gpxMeta{
			Name: "Lura history " + sum.From.UTC().Format("2006-01-02"),
			Time: time.Now().UTC().Format(time.RFC3339),
		},
	}

	for _, seg := range sum.Segments {
		if seg.Kind == "stop" {
			c := centroid(seg.Path)
			name := seg.AtPlace
			if name == "" {
				name = "Stop"
			}
			doc.Wpts = append(doc.Wpts, gpxWpt{
				Lat: c.Lat, Lon: c.Lon, Name: name,
				Time: seg.StartTS.UTC().Format(time.RFC3339),
				Desc: fmt.Sprintf("stopped for %s", seg.Duration().Round(time.Minute)),
			})
			continue
		}
		trk := gpxTrk{
			Name: strings.TrimSpace(seg.FromPlace + " → " + seg.ToPlace),
			Type: seg.Mode,
		}
		if trk.Name == "→" {
			trk.Name = seg.Mode + " " + seg.StartTS.UTC().Format("15:04")
		}
		var trkseg gpxTrkseg
		for _, p := range seg.Path {
			trkseg.Pts = append(trkseg.Pts, gpxWpt{Lat: p.Lat, Lon: p.Lon})
		}
		trk.Segs = append(trk.Segs, trkseg)
		doc.Trks = append(doc.Trks, trk)
	}

	body, err := xml.MarshalIndent(doc, "", "  ")
	if err != nil {
		return nil, err
	}
	return append([]byte(xml.Header), body...), nil
}

// ---------------------------------------------------------------- helpers

// sample is one position enriched with the derived values the segmenter needs.
type sample struct {
	pos   domain.Position
	speed float64
	gap   time.Duration
	distM float64
}

func runDuration(samples []sample) time.Duration {
	if len(samples) < 2 {
		return 0
	}
	return samples[len(samples)-1].pos.RecvTS.Sub(samples[0].pos.RecvTS)
}

func centroid(path []domain.Point) domain.Point {
	if len(path) == 0 {
		return domain.Point{}
	}
	var lat, lon float64
	for _, p := range path {
		lat += p.Lat
		lon += p.Lon
	}
	n := float64(len(path))
	return domain.Point{Lat: lat / n, Lon: lon / n}
}

// nearestPlaceName returns the name of the closest place whose circle contains
// the point, preferring the tightest fence when several overlap (a 60 m shop
// inside a 500 m "downtown" should win).
func nearestPlaceName(places []domain.Place, p domain.Point) string {
	best := ""
	bestRadius := math.MaxFloat64
	for _, place := range places {
		d := geo.DistanceM(place.Center.Lat, place.Center.Lon, p.Lat, p.Lon)
		if d <= float64(place.RadiusM) && float64(place.RadiusM) < bestRadius {
			best, bestRadius = place.Name, float64(place.RadiusM)
		}
	}
	return best
}

func placeName(places []domain.Place, id string) string {
	for _, p := range places {
		if p.ID == id {
			return p.Name
		}
	}
	return ""
}

func filterByPlace(segments []domain.Segment, name string) []domain.Segment {
	if name == "" {
		return segments
	}
	out := make([]domain.Segment, 0, len(segments))
	for _, s := range segments {
		if s.AtPlace == name || s.FromPlace == name || s.ToPlace == name {
			out = append(out, s)
		}
	}
	return out
}
