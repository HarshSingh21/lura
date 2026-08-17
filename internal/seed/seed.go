// Package seed creates a demo workspace.
//
// A location product is unusable-looking until it has places, notes and a day of
// history: an empty map and an empty timeline cannot tell you whether the thing
// works. Seeding gives a fresh install the same content the design mock shows, so
// `go run ./cmd/lura` is immediately a working control center.
//
// Two rules keep this honest:
//
//   - It only ever runs when the store is empty. It cannot overwrite real data.
//   - Seeded history is written straight to the store, never published on the
//     bus, so it fills the timeline without firing a single "you arrived"
//     reminder for a trip that happened in a fixture.
package seed

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
)

// DemoUserID is the single Phase 1 workspace behind the static API token.
const DemoUserID = "usr_demo"

// Result reports what seeding produced.
type Result struct {
	Created   bool
	User      domain.User
	Devices   []domain.Device
	PrimaryID string
	PubToken  string
	Places    int
	Notes     int
	Positions int
	Shares    int
}

// Options tunes seeding.
type Options struct {
	// DeviceToken pins the primary device's ingest credential, so a simulator or
	// an OwnTracks client can be configured from the same env var every restart.
	DeviceToken string
	// TZ is the demo user's timezone; history is generated in local hours so the
	// timeline reads sensibly ("8:04 AM", not "02:34 UTC").
	TZ string
	// WithShares seeds two active share links. Off for real deployments: a share
	// is a live grant of location data, so it should never appear by surprise.
	WithShares bool
	// WithHistory generates today's trips.
	WithHistory bool
	// Now overrides the clock (tests).
	Now func() time.Time
}

// Run seeds the workspace if it does not exist yet.
func Run(ctx context.Context, st store.Store, log *slog.Logger, o Options) (Result, error) {
	if log == nil {
		log = slog.Default()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.TZ == "" {
		o.TZ = "Asia/Kolkata"
	}

	if existing, err := st.GetUser(ctx, DemoUserID); err == nil {
		devices, _ := st.ListDevices(ctx, DemoUserID)
		res := Result{User: existing}
		if len(devices) > 0 {
			res.Devices = devices
			res.PrimaryID = devices[0].ID
			res.PubToken = devices[0].Token
		}
		return res, nil // already seeded: leave real data alone
	}

	loc, err := time.LoadLocation(o.TZ)
	if err != nil {
		loc = time.UTC
	}

	user := domain.User{
		ID:          DemoUserID,
		Email:       "you@lura.local",
		DisplayName: "Aravind",
		Locale:      "en",
		TZ:          o.TZ,
		QuietFrom:   "22:30",
		QuietTo:     "07:00",
		CreatedAt:   o.Now().UTC(),
	}
	if err := st.UpsertUser(ctx, user); err != nil {
		return Result{}, fmt.Errorf("seed user: %w", err)
	}
	res := Result{Created: true, User: user}

	// ---- devices
	phone := domain.Device{
		ID:     "dev_phone",
		UserID: user.ID,
		Name:   "My Phone",
		Kind:   "phone",
		Token:  o.DeviceToken,
	}
	if phone.Token == "" {
		phone.Token = idgen.Token()
	}
	watch := domain.Device{
		ID:     "dev_watch",
		UserID: user.ID,
		Name:   "Apple Watch",
		Kind:   "watch",
		Token:  idgen.Token(),
	}
	for _, d := range []domain.Device{phone, watch} {
		if err := st.UpsertDevice(ctx, d); err != nil {
			return res, fmt.Errorf("seed device %s: %w", d.ID, err)
		}
		res.Devices = append(res.Devices, d)
	}
	res.PrimaryID, res.PubToken = phone.ID, phone.Token

	// ---- places (the six from the design mock, around central Bengaluru)
	places := []domain.Place{
		{ID: "plc_home", Name: "Home", Tags: []string{"home"},
			Center: domain.Point{Lat: 12.9611, Lon: 77.6387}, RadiusM: 120,
			Triggers: []domain.Trigger{domain.TriggerArrive, domain.TriggerLeave}},
		{ID: "plc_office", Name: "Office", Tags: []string{"work"},
			Center: domain.Point{Lat: 12.9784, Lon: 77.6408}, RadiusM: 200,
			Triggers: []domain.Trigger{domain.TriggerArrive}},
		{ID: "plc_gym", Name: "Gym", Tags: []string{"health"},
			Center: domain.Point{Lat: 12.9668, Lon: 77.6290}, RadiusM: 80,
			Triggers: []domain.Trigger{domain.TriggerDwell}, DwellMins: 45},
		{ID: "plc_grocery", Name: "Whole Foods", Tags: []string{"grocery"},
			Center: domain.Point{Lat: 12.9705, Lon: 77.6350}, RadiusM: 60,
			Triggers: []domain.Trigger{domain.TriggerPassby}},
		{ID: "plc_moms", Name: "Mom's", Tags: []string{"family"},
			Center: domain.Point{Lat: 12.9520, Lon: 77.6100}, RadiusM: 150,
			Triggers: []domain.Trigger{domain.TriggerArrive}},
		{ID: "plc_library", Name: "City Library", Tags: []string{"errands"},
			Center: domain.Point{Lat: 12.9750, Lon: 77.6200}, RadiusM: 70,
			Triggers: []domain.Trigger{domain.TriggerPassby}},
	}
	for _, p := range places {
		p.UserID = user.ID
		p.CreatedAt = o.Now().UTC()
		if _, err := st.CreatePlace(ctx, p); err != nil {
			return res, fmt.Errorf("seed place %s: %w", p.ID, err)
		}
		res.Places++
	}

	// ---- notes
	notes := []domain.Note{
		{Text: "Buy oat milk & eggs", PlaceID: "plc_grocery", Trigger: domain.TriggerPassby, Tags: []string{"grocery"}},
		{Text: "Return library books", PlaceID: "plc_library", Trigger: domain.TriggerPassby, Tags: []string{"errands"}},
		{Text: "Pick up dry cleaning", PlaceID: "plc_home", Trigger: domain.TriggerLeave, Tags: []string{"errands"}},
		{Text: "Call landlord about lease", PlaceID: "plc_home", Trigger: domain.TriggerArrive, Tags: []string{"admin"}},
		{Text: "Water the plants", PlaceID: "plc_home", Trigger: domain.TriggerArrive, Tags: []string{"home"}, Done: true},
	}
	base := o.Now().UTC().Add(-48 * time.Hour)
	for i, n := range notes {
		n.UserID = user.ID
		// Distinct creation times keep the list order stable and deterministic.
		n.CreatedAt = base.Add(time.Duration(i) * time.Minute)
		if _, err := st.CreateNote(ctx, n); err != nil {
			return res, fmt.Errorf("seed note %d: %w", i, err)
		}
		res.Notes++
	}

	// ---- channels: the log channel always works and needs no configuration, so
	// a seeded workspace has a working delivery path out of the box.
	if _, err := st.CreateChannel(ctx, domain.Channel{
		UserID: user.ID, Type: "log", Enabled: true, Priority: 50,
		Config: map[string]string{}, CreatedAt: o.Now().UTC(),
	}); err != nil {
		return res, fmt.Errorf("seed channel: %w", err)
	}

	// ---- history
	if o.WithHistory {
		n, err := seedDay(ctx, st, phone.ID, user.ID, places, o.Now().In(loc))
		if err != nil {
			return res, err
		}
		res.Positions = n
	}

	// ---- shares
	if o.WithShares {
		now := o.Now().UTC()
		twoHours := now.Add(2 * time.Hour)
		dayCap := now.Add(24 * time.Hour)
		demo := []domain.Share{
			{ID: "shr_priya", Label: "Priya", Mode: domain.ShareUntilArrive,
				ArrivePlace: "plc_home", ExpiresAt: &dayCap},
			{ID: "shr_family", Label: "Family group", Mode: domain.ShareDuration,
				ExpiresAt: &twoHours},
		}
		for _, sh := range demo {
			sh.UserID = user.ID
			sh.CreatedAt = now
			sh.Token = idgen.ShortToken()
			if _, err := st.CreateShare(ctx, sh); err != nil {
				return res, fmt.Errorf("seed share %s: %w", sh.ID, err)
			}
			res.Shares++
		}
	}

	log.InfoContext(ctx, "seeded demo workspace",
		"user", user.ID, "places", res.Places, "notes", res.Notes,
		"positions", res.Positions, "shares", res.Shares)
	return res, nil
}

// waypoint is one leg of the seeded day.
type waypoint struct {
	place    string
	stopMins int
	mode     string // Drive | Walk
}

// seedDay writes a plausible day: home → office (long stop) → grocery (short
// stop) → gym. It is the same shape as the mock's timeline, so the History view
// has trips, stops and a track to draw the moment the server starts.
func seedDay(ctx context.Context, st store.Store, deviceID, userID string, places []domain.Place, localNow time.Time) (int, error) {
	byID := map[string]domain.Place{}
	for _, p := range places {
		byID[p.ID] = p
	}

	legs := []waypoint{
		{place: "plc_home", stopMins: 0},
		{place: "plc_office", stopMins: 200, mode: "Drive"},
		{place: "plc_grocery", stopMins: 14, mode: "Drive"},
		{place: "plc_gym", stopMins: 50, mode: "Drive"},
	}

	// Start at 08:04 local, or earlier if the process starts early in the day, so
	// the generated day always ends before "now".
	start := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 8, 4, 0, 0, localNow.Location())
	if !start.Before(localNow) {
		start = localNow.Add(-6 * time.Hour)
	}

	const (
		fixEvery   = 30 * time.Second
		stopEvery  = 5 * time.Minute // stationary fixes are sparse: the phone is still
		driveSpeed = 11.0            // m/s ≈ 40 km/h city driving
	)

	cursor := start
	var positions []domain.Position
	battery := 92

	emit := func(pt domain.Point, ts time.Time, speed float64) {
		if ts.After(localNow) {
			return // never write the future
		}
		positions = append(positions, domain.Position{
			DeviceID: deviceID,
			UserID:   userID,
			RecvTS:   ts.UTC(),
			DeviceTS: ts.UTC(),
			Point:    pt,
			SpeedMPS: speed,
			// A little jitter keeps the accuracy column from looking synthetic and
			// exercises the segmenter's tolerance for imperfect fixes.
			AccuracyM: 6 + math.Mod(float64(ts.Unix()), 7),
			Battery:   battery,
		})
	}

	// Opening stop at home.
	for i := 0; i < 6; i++ {
		emit(byID["plc_home"].Center, cursor, 0)
		cursor = cursor.Add(stopEvery)
	}

	for i := 1; i < len(legs); i++ {
		from := byID[legs[i-1].place]
		to := byID[legs[i].place]

		distM := geo.DistanceM(from.Center.Lat, from.Center.Lon, to.Center.Lat, to.Center.Lon)
		bearing := geo.BearingDeg(from.Center.Lat, from.Center.Lon, to.Center.Lat, to.Center.Lon)
		steps := int(distM/(driveSpeed*fixEvery.Seconds())) + 1

		for step := 1; step <= steps; step++ {
			frac := float64(step) / float64(steps)
			lat, lon := geo.Destination(from.Center.Lat, from.Center.Lon, bearing, distM*frac)
			// Ease in and out so the trip has an acceleration profile, which is what
			// the fly-by filter and the mode classifier actually see in real data.
			speed := driveSpeed * math.Sin(frac*math.Pi)
			if speed < 1.5 {
				speed = 1.5
			}
			emit(domain.Point{Lat: lat, Lon: lon}, cursor, speed)
			cursor = cursor.Add(fixEvery)
		}

		// Arrive and stay.
		stop := time.Duration(legs[i].stopMins) * time.Minute
		for waited := time.Duration(0); waited <= stop; waited += stopEvery {
			emit(to.Center, cursor, 0)
			cursor = cursor.Add(stopEvery)
		}
		if battery > 40 {
			battery -= 9
		}
	}

	if len(positions) == 0 {
		return 0, nil
	}
	written, err := st.InsertPositions(ctx, positions)
	if err != nil {
		return 0, fmt.Errorf("seed positions: %w", err)
	}

	// Advance last_point to the final fix so the live map opens on the device's
	// last known location rather than nowhere.
	last := positions[len(positions)-1]
	if _, err := st.TouchLastPoint(ctx, deviceID, last.Point, last.RecvTS, last.SpeedMPS, last.Battery); err != nil {
		return written, fmt.Errorf("seed last point: %w", err)
	}
	return written, nil
}
