// Package geofence evaluates place triggers against the live position stream.
//
// This is the Phase 1 shape of HLD §5.4: inline ST_DWithin per fix, an
// in-process "currently inside" set per device, and the same guards the Phase 2
// Tile38 worker needs. Tile38 would own enter/exit detection; everything layered
// on top of it lives here either way, and that layering is the interesting part:
//
//	freshness gate → enter/exit diff → debounce (fly-by filter) → cool-off → emit
//
// Why each guard exists:
//
//   - Freshness gate. An offline phone that reconnects replays an hour of queued
//     fixes. Those must fill in history but must not announce arrivals that
//     already happened, so fixes older than FreshWindow are never evaluated
//     (they still reach the writer — the two paths are decoupled precisely so
//     replay cannot fire reminders).
//   - Monotonic evaluation. Within the fresh window, a fix older than the last
//     one already evaluated for that device is skipped too: state must reflect
//     the newest known position, or an out-of-order fix would resurrect a fence
//     the device has already left.
//   - Debounce / fly-by filter. Entering a 60 m circle at 50 km/h is not an
//     arrival. "Arrive" waits for the device to slow below ArriveMaxSpeed or to
//     stay inside for ArriveDebounce. This is why the HLD measures the < 2 s NFR
//     from the *confirming* fix, not from first entry.
//   - Dwell. Not a primitive event: on enter a timer is armed and persisted (in
//     the store, not a cache — HLD §17 flags cache-only dwell as a data-loss
//     risk), then cancelled by an exit or fired by the ticker.
//   - Cool-off. An atomic claim per (device, place, trigger). Only the winner
//     fires, so a jittering GPS fix on a fence boundary produces one reminder
//     rather than twelve.
//
// A fix is evaluated against its own user's places and against the places of
// every connected person who watches that user — but only while the user's own
// sharing toward them is live (see peerPlaces). The event for a peer crossing
// belongs to the place owner and is published on the owner's subject alone.
package geofence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/gate"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Config tunes the engine. Defaults come from config.Config, which sources them
// from the environment — every one of these is listed in HLD §17 as a product
// default still to be decided, so none of them is hard-coded.
type Config struct {
	FreshWindow       time.Duration
	ArriveDebounce    time.Duration
	ArriveMaxSpeedMPS float64
	PassbyMinSpeedMPS float64
	CoolOff           time.Duration
	DwellTick         time.Duration
	Partitions        int
	// DefaultDwell applies when a place asks for a dwell trigger without saying
	// how long.
	DefaultDwell time.Duration
}

func (c Config) withDefaults() Config {
	if c.FreshWindow <= 0 {
		c.FreshWindow = 5 * time.Minute
	}
	if c.ArriveDebounce <= 0 {
		c.ArriveDebounce = 45 * time.Second
	}
	if c.ArriveMaxSpeedMPS <= 0 {
		c.ArriveMaxSpeedMPS = 1.5
	}
	if c.PassbyMinSpeedMPS <= 0 {
		c.PassbyMinSpeedMPS = 3
	}
	if c.CoolOff <= 0 {
		c.CoolOff = 30 * time.Minute
	}
	if c.DwellTick <= 0 {
		c.DwellTick = 10 * time.Second
	}
	if c.Partitions < 1 {
		c.Partitions = 4
	}
	if c.DefaultDwell <= 0 {
		c.DefaultDwell = 15 * time.Minute
	}
	return c
}

// fenceState is what the engine remembers about one device inside one place.
//
// OwnerID is the place owner. It differs from the device's user when the place
// belongs to a connected peer who watches this device's user, and it is what
// keeps a peer's inside-state independent per owner's place: place IDs are
// globally unique, so (device, place) is the key either way.
type fenceState struct {
	OwnerID         string
	EnteredAt       time.Time
	ArriveConfirmed bool
	DwellArmed      bool
}

// deviceState is the per-device evaluation state. All mutations happen on the
// partition goroutine that owns the device, guarded by mu for the benefit of
// snapshot readers (/healthz, tests).
type deviceState struct {
	mu       sync.Mutex
	UserID   string
	LastEval time.Time
	Inside   map[string]*fenceState
}

// Engine is the geofence evaluator.
type Engine struct {
	store store.Store
	b     bus.Bus
	log   *slog.Logger
	cool  gate.Gate
	cfg   Config
	now   func() time.Time

	mu     sync.RWMutex
	states map[string]*deviceState

	sub  bus.Subscription
	done chan struct{}
	wg   sync.WaitGroup
	once sync.Once
}

// New returns an unstarted engine.
func New(st store.Store, b bus.Bus, cool gate.Gate, log *slog.Logger, cfg Config) *Engine {
	if log == nil {
		log = slog.Default()
	}
	if cool == nil {
		cool = gate.NewMemory()
	}
	return &Engine{
		store:  st,
		b:      b,
		log:    log,
		cool:   cool,
		cfg:    cfg.withDefaults(),
		now:    time.Now,
		states: map[string]*deviceState{},
		done:   make(chan struct{}),
	}
}

// WithClock overrides the clock (tests).
func (e *Engine) WithClock(now func() time.Time) *Engine {
	e.now = now
	return e
}

// Start subscribes to the durable position stream and starts the dwell ticker.
//
// The subscription is partitioned by device_id, which is the ordering guarantee
// the whole design rests on: all fixes for one device are evaluated by one
// goroutine, in publish order.
func (e *Engine) Start(ctx context.Context) error {
	sub, err := e.b.SubscribePartitioned(bus.PosAll(), e.cfg.Partitions, bus.DeviceKey, func(m bus.Msg) {
		var pos domain.Position
		if err := json.Unmarshal(m.Data, &pos); err != nil {
			e.log.Error("geofence: undecodable position", "subject", m.Subject, "error", err)
			return
		}
		if err := e.Evaluate(context.WithoutCancel(ctx), pos); err != nil {
			e.log.Error("geofence: evaluate failed", "device", pos.DeviceID, "error", err)
		}
	})
	if err != nil {
		return err
	}
	e.sub = sub

	e.wg.Add(1)
	go e.dwellLoop(context.WithoutCancel(ctx))
	return nil
}

// Stop stops the engine.
func (e *Engine) Stop() {
	e.once.Do(func() {
		if e.sub != nil {
			e.sub.Unsubscribe()
		}
		close(e.done)
	})
	e.wg.Wait()
}

// Evaluate runs the full pipeline for one fix. It is safe to call directly,
// which is how the tests drive it.
func (e *Engine) Evaluate(ctx context.Context, pos domain.Position) error {
	start := e.now()
	ctx, span := obs.Start(ctx, "geofence.evaluate", trace.WithAttributes(
		attribute.String("lura.device_id", pos.DeviceID),
		attribute.Float64("lura.speed_mps", pos.SpeedMPS),
	))
	defer span.End()
	defer func() { metrics.GeoEvalSeconds.ObserveSince(start) }()

	// ---- gate 1: freshness. Stale fixes are history, not news.
	age := start.Sub(pos.RecvTS)
	if age > e.cfg.FreshWindow {
		metrics.GeoDroppedStale.Inc(metrics.AttrDevice.String(pos.DeviceID))
		span.SetAttributes(attribute.Bool("lura.dropped_stale", true))
		e.log.DebugContext(ctx, "geofence: dropped stale fix",
			"device", pos.DeviceID, "age", age.String(), "freshWindow", e.cfg.FreshWindow.String())
		return nil
	}

	st := e.stateFor(pos.DeviceID, pos.UserID)
	st.mu.Lock()
	defer st.mu.Unlock()

	// ---- gate 2: monotonic evaluation, so an out-of-order fix cannot rewind
	// the inside set.
	if !st.LastEval.IsZero() && !pos.RecvTS.After(st.LastEval) {
		span.SetAttributes(attribute.Bool("lura.out_of_order", true))
		return nil
	}
	st.LastEval = pos.RecvTS

	// ---- enter/exit diff. PostGIS answers this with ST_DWithin / ST_Covers
	// over GIST indexes; Tile38 would push it as an event in Phase 2. The
	// geometry is re-read on every fix, so a fence that was moved or reshaped
	// since the last one is judged by where it is now.
	inside, err := e.store.PlacesContaining(ctx, pos.UserID, pos.Point)
	if err != nil {
		return fmt.Errorf("geofence: places containing: %w", err)
	}

	// The same question for every connected person this user shares with live
	// who watches them on one of their own fences.
	peers := e.peerPlaces(ctx, pos)
	inside = append(inside, peers.inside...)

	insideByID := make(map[string]domain.Place, len(inside))
	for _, p := range inside {
		insideByID[p.ID] = p
	}

	// Exits first: leaving a fence cancels its pending dwell before anything
	// else can arm a new one.
	for placeID, fs := range st.Inside {
		if _, still := insideByID[placeID]; still {
			continue
		}
		if fs.OwnerID != "" && fs.OwnerID != pos.UserID {
			if peers.unknownOwner(fs.OwnerID) {
				// The owner's fences could not be read this time. Keep the state
				// rather than invent a leave (or silently forget an arrival).
				continue
			}
			if !peers.watched[placeID] {
				// Consent was withdrawn, or the owner stopped watching: forget the
				// fence without announcing a crossing nobody may now observe.
				e.forgetFence(ctx, st, placeID, pos)
				continue
			}
		}
		e.handleExit(ctx, st, placeID, fs, pos)
	}

	for _, place := range inside {
		fs, wasInside := st.Inside[place.ID]
		if !wasInside {
			e.handleEnter(ctx, st, place, pos)
			continue
		}
		e.handleStillInside(ctx, st, place, fs, pos)
	}

	span.SetAttributes(
		attribute.Int("lura.inside_count", len(inside)),
		attribute.Int("lura.peer_inside_count", len(peers.inside)),
	)
	return nil
}

// peerScope is what one fix may be evaluated against beyond its own user's
// places.
type peerScope struct {
	// inside are watched peer places that contain the fix.
	inside []domain.Place
	// watched are the IDs of every peer place currently allowed to evaluate
	// this user, containing the fix or not — what separates "left the fence"
	// from "may no longer be watched".
	watched map[string]bool
	// unknown are owners whose places could not be read on this fix;
	// allUnknown means not even the connection list could.
	unknown    map[string]bool
	allUnknown bool
}

func (s peerScope) unknownOwner(owner string) bool { return s.allUnknown || s.unknown[owner] }

// peerPlaces finds the places of other users that this fix may cross.
//
// The rule is the consent model from internal/connect, applied to geofencing:
// owner W may evaluate user U's position only while *U's own* row toward W is
// Live() — accepted, and U's sharing switch on. Reading U's row (not W's) is
// the point: W cannot opt in on U's behalf. Within that, only W's places that
// list U in watchUserIds, or that carry one of W's open notes watching U, are
// evaluated. Pausing sharing therefore stops evaluation on the very next fix.
func (e *Engine) peerPlaces(ctx context.Context, pos domain.Position) peerScope {
	scope := peerScope{watched: map[string]bool{}, unknown: map[string]bool{}}

	conns, err := e.store.ListConnections(ctx, pos.UserID)
	if err != nil {
		e.log.WarnContext(ctx, "geofence: list connections failed", "user", pos.UserID, "error", err)
		// Without the connection list nothing is known about any owner, so keep
		// every peer fence as it is.
		scope.allUnknown = true
		return scope
	}

	notDone := false
	for _, c := range conns {
		if !c.Live() {
			continue
		}
		owner := c.PeerID
		places, err := e.store.ListPlaces(ctx, owner)
		if err != nil {
			e.log.WarnContext(ctx, "geofence: list peer places failed", "owner", owner, "error", err)
			scope.unknown[owner] = true
			continue
		}
		notes, err := e.store.ListNotes(ctx, owner, store.NoteFilter{Done: &notDone})
		if err != nil {
			e.log.WarnContext(ctx, "geofence: list peer notes failed", "owner", owner, "error", err)
			scope.unknown[owner] = true
			continue
		}
		noteWatch := map[string]bool{}
		for _, n := range notes {
			if n.WatchUserID == pos.UserID && n.PlaceID != "" {
				noteWatch[n.PlaceID] = true
			}
		}

		watching := false
		for _, p := range places {
			if p.Watches(pos.UserID) || noteWatch[p.ID] {
				scope.watched[p.ID] = true
				watching = true
			}
		}
		if !watching {
			continue // nothing of this owner's watches this user: skip the spatial query
		}

		containing, err := e.store.PlacesContaining(ctx, owner, pos.Point)
		if err != nil {
			e.log.WarnContext(ctx, "geofence: peer places containing failed", "owner", owner, "error", err)
			scope.unknown[owner] = true
			continue
		}
		for _, p := range containing {
			if scope.watched[p.ID] {
				scope.inside = append(scope.inside, p)
			}
		}
	}
	return scope
}

func (e *Engine) handleEnter(ctx context.Context, st *deviceState, place domain.Place, pos domain.Position) {
	fs := &fenceState{OwnerID: place.UserID, EnteredAt: pos.RecvTS}
	if st.Inside == nil {
		st.Inside = map[string]*fenceState{}
	}
	st.Inside[place.ID] = fs

	e.log.DebugContext(ctx, "geofence: enter",
		"device", pos.DeviceID, "place", place.Name, "speedMps", pos.SpeedMPS)

	// Pass-by: entering while still moving. This is the place-level Phase 1
	// approximation of the route corridors in HLD §5.5 — a corridor is a
	// buffered polyline, but the trigger condition (enter while moving) is the
	// same, so the Phase 2 change is the fence geometry, not this logic.
	if hasTrigger(place, domain.TriggerPassby) && pos.SpeedMPS >= e.cfg.PassbyMinSpeedMPS {
		e.fire(ctx, place, pos, domain.TriggerPassby)
	}

	// Arrive: confirm immediately only if the device is already slow. Otherwise
	// hold it for the debounce window.
	if hasTrigger(place, domain.TriggerArrive) {
		if pos.SpeedMPS <= e.cfg.ArriveMaxSpeedMPS {
			if e.fire(ctx, place, pos, domain.TriggerArrive) {
				fs.ArriveConfirmed = true
			}
		} else {
			metrics.GeoDebounceHold.Inc(metrics.AttrTrigger.String(string(domain.TriggerArrive)))
		}
	}

	// Dwell: arm a durable timer.
	if hasTrigger(place, domain.TriggerDwell) {
		e.armDwell(ctx, st, place, pos, fs)
	}
}

func (e *Engine) handleStillInside(ctx context.Context, st *deviceState, place domain.Place, fs *fenceState, pos domain.Position) {
	// Arrive confirmation: either the device slowed down, or it has been inside
	// long enough that a fly-by is ruled out.
	if hasTrigger(place, domain.TriggerArrive) && !fs.ArriveConfirmed {
		slowed := pos.SpeedMPS <= e.cfg.ArriveMaxSpeedMPS
		stayed := pos.RecvTS.Sub(fs.EnteredAt) >= e.cfg.ArriveDebounce
		if slowed || stayed {
			if e.fire(ctx, place, pos, domain.TriggerArrive) {
				fs.ArriveConfirmed = true
			}
		} else {
			metrics.GeoDebounceHold.Inc(metrics.AttrTrigger.String(string(domain.TriggerArrive)))
		}
	}

	// A place can gain a dwell trigger while the device is already inside.
	if hasTrigger(place, domain.TriggerDwell) && !fs.DwellArmed {
		e.armDwell(ctx, st, place, pos, fs)
	}
}

// forgetFence drops a device's state for a fence without firing anything. It is
// the path for a peer fence the device's user may no longer be evaluated
// against: no leave is announced, because nobody is entitled to observe it.
func (e *Engine) forgetFence(ctx context.Context, st *deviceState, placeID string, pos domain.Position) {
	delete(st.Inside, placeID)
	if err := e.store.DeletePendingDwell(ctx, pos.DeviceID, placeID); err != nil {
		e.log.WarnContext(ctx, "geofence: cancel pending dwell failed",
			"device", pos.DeviceID, "place", placeID, "error", err)
	}
	e.log.DebugContext(ctx, "geofence: peer fence forgotten", "device", pos.DeviceID, "place", placeID)
}

func (e *Engine) handleExit(ctx context.Context, st *deviceState, placeID string, fs *fenceState, pos domain.Position) {
	delete(st.Inside, placeID)

	// Cancel any pending dwell: the user left before the timer matured.
	if err := e.store.DeletePendingDwell(ctx, pos.DeviceID, placeID); err != nil {
		e.log.WarnContext(ctx, "geofence: cancel pending dwell failed",
			"device", pos.DeviceID, "place", placeID, "error", err)
	}

	owner := fs.OwnerID
	if owner == "" {
		owner = pos.UserID
	}
	place, err := e.store.GetPlace(ctx, owner, placeID)
	if err != nil {
		// The place was deleted while the device was inside it: nothing to fire.
		if !errors.Is(err, domain.ErrNotFound) {
			e.log.WarnContext(ctx, "geofence: exit lookup failed", "place", placeID, "error", err)
		}
		return
	}

	e.log.DebugContext(ctx, "geofence: exit", "device", pos.DeviceID, "place", place.Name)

	if hasTrigger(place, domain.TriggerLeave) {
		e.fire(ctx, place, pos, domain.TriggerLeave)
	}

	// Note what is deliberately *not* done here: the arrive cool-off is not
	// released on exit. A GPS fix jittering across a fence boundary produces a
	// stream of exit/enter pairs, and releasing the claim would let every one of
	// them re-fire "you arrived" — which is the exact failure the cool-off exists
	// to prevent (HLD §5.4). The claim expires on its own after CoolOff, so a
	// genuine return later still fires.
}

func (e *Engine) armDwell(ctx context.Context, _ *deviceState, place domain.Place, pos domain.Position, fs *fenceState) {
	d := e.cfg.DefaultDwell
	if place.DwellMins > 0 {
		d = time.Duration(place.DwellMins) * time.Minute
	}
	// The timer belongs to the place owner: it is their fence and their
	// overview that lists it. For a watched peer that is not the device's user,
	// which is why the restart path resolves the device separately.
	pd := domain.PendingDwell{
		DeviceID:  pos.DeviceID,
		UserID:    place.UserID,
		PlaceID:   place.ID,
		EnteredAt: fs.EnteredAt,
		FireAt:    fs.EnteredAt.Add(d),
	}
	if err := e.store.PutPendingDwell(ctx, pd); err != nil {
		e.log.ErrorContext(ctx, "geofence: arm dwell failed",
			"device", pos.DeviceID, "place", place.ID, "error", err)
		return
	}
	fs.DwellArmed = true
	metrics.GeoDwellArmed.Inc()
	e.log.DebugContext(ctx, "geofence: dwell armed",
		"device", pos.DeviceID, "place", place.Name, "fireAt", pd.FireAt)
}

// dwellLoop fires matured dwell timers. It reloads them from the store, so a
// restart resumes pending dwells instead of losing them.
func (e *Engine) dwellLoop(ctx context.Context) {
	defer e.wg.Done()
	ticker := time.NewTicker(e.cfg.DwellTick)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			e.runDwellDue(ctx)
		case <-e.done:
			return
		}
	}
}

func (e *Engine) runDwellDue(ctx context.Context) {
	now := e.now()
	due, err := e.store.DuePendingDwells(ctx, now)
	if err != nil {
		e.log.ErrorContext(ctx, "geofence: load due dwells failed", "error", err)
		return
	}
	for _, pd := range due {
		subject, inside, err := e.stillInside(ctx, pd)
		if err != nil {
			e.log.WarnContext(ctx, "geofence: dwell inside-check failed",
				"device", pd.DeviceID, "place", pd.PlaceID, "error", err)
			continue
		}
		// Whether it fires or not, the timer is spent.
		if err := e.store.DeletePendingDwell(ctx, pd.DeviceID, pd.PlaceID); err != nil {
			e.log.WarnContext(ctx, "geofence: clear dwell failed", "error", err)
		}
		if !inside {
			continue
		}
		place, err := e.store.GetPlace(ctx, pd.UserID, pd.PlaceID)
		if err != nil {
			continue
		}
		pos := domain.Position{
			DeviceID: pd.DeviceID,
			UserID:   subject,
			RecvTS:   now,
			Point:    place.Center,
		}
		e.fire(ctx, place, pos, domain.TriggerDwell)

		if st := e.peekState(pd.DeviceID); st != nil {
			st.mu.Lock()
			if fs, ok := st.Inside[pd.PlaceID]; ok {
				fs.DwellArmed = false
			}
			st.mu.Unlock()
		}
	}
}

// stillInside answers "is the device inside this place right now?" using live
// state when the engine has it, and the device's last known point when it does
// not (which is the case for a timer reloaded after a restart). It also returns
// whose device it is — the place owner's, or a watched peer's.
//
// A peer's dwell re-checks consent at maturity: sharing paused (or the watch
// removed) while the timer ran means it must not fire, even if no fix has
// arrived since to clear the state.
func (e *Engine) stillInside(ctx context.Context, pd domain.PendingDwell) (string, bool, error) {
	if st := e.peekState(pd.DeviceID); st != nil {
		st.mu.Lock()
		_, inside := st.Inside[pd.PlaceID]
		subject := st.UserID
		st.mu.Unlock()
		if inside && subject != pd.UserID {
			ok, err := e.mayWatch(ctx, pd.UserID, subject, pd.PlaceID)
			if err != nil {
				return "", false, err
			}
			inside = ok
		}
		return subject, inside, nil
	}

	dev, err := e.dwellDevice(ctx, pd)
	if err != nil {
		return "", false, err
	}
	if dev.LastPoint == nil || dev.LastSeen == nil {
		return dev.UserID, false, nil
	}
	// A last fix older than the freshness window tells us nothing useful.
	if e.now().Sub(*dev.LastSeen) > e.cfg.FreshWindow {
		return dev.UserID, false, nil
	}
	if dev.UserID != pd.UserID {
		ok, err := e.mayWatch(ctx, pd.UserID, dev.UserID, pd.PlaceID)
		if err != nil || !ok {
			return dev.UserID, false, err
		}
	}
	place, err := e.store.GetPlace(ctx, pd.UserID, pd.PlaceID)
	if err != nil {
		return "", false, err
	}
	return dev.UserID, place.Contains(*dev.LastPoint), nil
}

// dwellDevice finds the device behind a reloaded timer: the owner's own, or
// one belonging to a person the owner is connected to. Reads stay user-scoped —
// a device is only looked up under a user the owner has a connection with.
func (e *Engine) dwellDevice(ctx context.Context, pd domain.PendingDwell) (domain.Device, error) {
	dev, err := e.store.GetDevice(ctx, pd.UserID, pd.DeviceID)
	if err == nil || !errors.Is(err, domain.ErrNotFound) {
		return dev, err
	}
	conns, cerr := e.store.ListConnections(ctx, pd.UserID)
	if cerr != nil {
		return domain.Device{}, cerr
	}
	for _, c := range conns {
		if dev, perr := e.store.GetDevice(ctx, c.PeerID, pd.DeviceID); perr == nil {
			return dev, nil
		}
	}
	return domain.Device{}, err
}

// mayWatch reports whether owner may currently evaluate subject against
// placeID: subject's own row toward owner is live, and the place (or one of the
// owner's open notes on it) still watches subject. It is the same rule
// peerPlaces applies per fix, asked about one place.
func (e *Engine) mayWatch(ctx context.Context, owner, subject, placeID string) (bool, error) {
	conn, err := e.store.GetConnection(ctx, subject, owner)
	if errors.Is(err, domain.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !conn.Live() {
		return false, nil
	}
	place, err := e.store.GetPlace(ctx, owner, placeID)
	if errors.Is(err, domain.ErrNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if place.Watches(subject) {
		return true, nil
	}
	notDone := false
	notes, err := e.store.ListNotes(ctx, owner, store.NoteFilter{PlaceID: placeID, Done: &notDone})
	if err != nil {
		return false, err
	}
	for _, n := range notes {
		if n.WatchUserID == subject {
			return true, nil
		}
	}
	return false, nil
}

// fire runs the cool-off gate and, if it wins, publishes the geo event.
// It reports whether the event was published.
func (e *Engine) fire(ctx context.Context, place domain.Place, pos domain.Position, trigger domain.Trigger) bool {
	ctx, span := obs.Start(ctx, "geofence.fire", trace.WithAttributes(
		attribute.String("lura.place_id", place.ID),
		attribute.String("lura.trigger", string(trigger)),
	))
	defer span.End()

	ok, err := e.cool.Acquire(ctx, coolKey(pos.DeviceID, place.ID, trigger), e.cfg.CoolOff)
	if err != nil {
		e.log.ErrorContext(ctx, "geofence: cool-off gate failed", "error", err)
		return false
	}
	if !ok {
		metrics.GeoCooloffSuppr.Inc(metrics.AttrTrigger.String(string(trigger)))
		span.SetAttributes(attribute.Bool("lura.suppressed", true))
		e.log.DebugContext(ctx, "geofence: suppressed by cool-off",
			"device", pos.DeviceID, "place", place.Name, "trigger", trigger)
		return false
	}

	// The event belongs to the place owner and goes out on their subject only;
	// for a watched peer, the peer is the subject but never the recipient.
	ev := domain.GeoEvent{
		ID:            idgen.New("geo"),
		UserID:        place.UserID,
		DeviceID:      pos.DeviceID,
		PlaceID:       place.ID,
		PlaceName:     place.Name,
		Trigger:       trigger,
		TS:            pos.RecvTS,
		Point:         pos.Point,
		SpeedMPS:      pos.SpeedMPS,
		SubjectUserID: pos.UserID,
		SubjectName:   e.displayName(ctx, pos.UserID),
	}
	if ev.UserID == "" {
		ev.UserID = pos.UserID
	}
	if ev.TS.IsZero() {
		ev.TS = e.now()
	}

	// Durable: a geo event that is lost is a reminder that never arrives.
	if err := bus.PublishDurableJSON(e.b, bus.GeoSubject(ev.UserID), ev); err != nil {
		e.log.ErrorContext(ctx, "geofence: publish geo event failed", "error", err)
		return false
	}
	// Also on the live path so the UI can react immediately.
	if err := bus.PublishJSON(e.b, bus.GeoSubject(ev.UserID), ev); err != nil {
		e.log.WarnContext(ctx, "geofence: live geo publish failed", "error", err)
	}

	metrics.GeoEventsFired.Inc(metrics.AttrTrigger.String(string(trigger)))
	e.log.InfoContext(ctx, "geofence event",
		"trigger", trigger, "place", place.Name, "device", pos.DeviceID, "event", ev.ID,
		"owner", ev.UserID, "subject", ev.SubjectUserID)
	return true
}

// displayName is how a toast names the person who crossed ("Nishtha arrived at
// Grocery"). A lookup failure degrades to an empty name, never a lost event.
func (e *Engine) displayName(ctx context.Context, userID string) string {
	u, err := e.store.GetUser(ctx, userID)
	if err != nil {
		return ""
	}
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Email
}

func (e *Engine) stateFor(deviceID, userID string) *deviceState {
	e.mu.RLock()
	st, ok := e.states[deviceID]
	e.mu.RUnlock()
	if ok {
		return st
	}

	e.mu.Lock()
	defer e.mu.Unlock()
	if st, ok := e.states[deviceID]; ok {
		return st
	}
	st = &deviceState{UserID: userID, Inside: map[string]*fenceState{}}
	e.states[deviceID] = st
	return st
}

func (e *Engine) peekState(deviceID string) *deviceState {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.states[deviceID]
}

// InsideSnapshot reports which places each device is currently inside. Used by
// /healthz and by tests; it is a copy, not the live map.
func (e *Engine) InsideSnapshot() map[string][]string {
	e.mu.RLock()
	devices := make([]string, 0, len(e.states))
	states := make([]*deviceState, 0, len(e.states))
	for id, st := range e.states {
		devices = append(devices, id)
		states = append(states, st)
	}
	e.mu.RUnlock()

	out := make(map[string][]string, len(states))
	for i, st := range states {
		st.mu.Lock()
		places := make([]string, 0, len(st.Inside))
		for placeID, fs := range st.Inside {
			// Only the device owner's own places. A peer's fence the device is
			// inside is the watcher's business: listing it here would tell the
			// watched person which of someone else's fences they are in.
			if fs.OwnerID != "" && fs.OwnerID != st.UserID {
				continue
			}
			places = append(places, placeID)
		}
		st.mu.Unlock()
		out[devices[i]] = places
	}
	return out
}

// Forget drops cached state for a device (used when a device is deleted).
func (e *Engine) Forget(deviceID string) {
	e.mu.Lock()
	delete(e.states, deviceID)
	e.mu.Unlock()
}

func hasTrigger(p domain.Place, t domain.Trigger) bool {
	for _, have := range p.Triggers {
		if have == t {
			return true
		}
	}
	return false
}

func coolKey(deviceID, placeID string, t domain.Trigger) string {
	return "cooloff:" + deviceID + ":" + placeID + ":" + string(t)
}
