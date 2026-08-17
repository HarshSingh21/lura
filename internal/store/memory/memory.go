// Package memory is an in-process implementation of store.Store.
//
// It exists for two reasons: unit/integration tests run against it without any
// infrastructure, and `lura -store=memory` gives a full working stack (live map,
// geofences, reminders, history) on a laptop with nothing installed. Spatial
// predicates that PostGIS would answer with ST_DWithin over a GIST index are
// answered here by geo.BBoxAround + geo.DistanceM, which is the same fallback
// path HLD §10 describes for a Tile38 outage.
//
// Everything is guarded by one RWMutex. That is deliberate: the data set is a
// single user's working state, and a coarse lock is easier to reason about than
// per-aggregate locking for a store whose job is to be obviously correct.
package memory

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/geo"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Store is an in-memory store.Store.
type Store struct {
	mu sync.RWMutex

	users     map[string]domain.User
	devices   map[string]domain.Device
	devToken  map[string]string // token -> device id
	positions map[string][]domain.Position
	posSeen   map[string]map[int64]struct{} // device -> recv_ts µs, the idempotency key
	places    map[string]domain.Place
	notes     map[string]domain.Note
	shares    map[string]domain.Share
	shrToken  map[string]string // token -> share id
	channels  map[string]domain.Channel
	events    []domain.TriggerEvent
	dwells    map[string]domain.PendingDwell

	// maxPositionsPerDevice bounds memory use; oldest fixes are dropped, which
	// is the in-memory analogue of Timescale retention.
	maxPositionsPerDevice int
}

// New returns an empty store.
func New() *Store {
	return &Store{
		users:                 map[string]domain.User{},
		devices:               map[string]domain.Device{},
		devToken:              map[string]string{},
		positions:             map[string][]domain.Position{},
		posSeen:               map[string]map[int64]struct{}{},
		places:                map[string]domain.Place{},
		notes:                 map[string]domain.Note{},
		shares:                map[string]domain.Share{},
		shrToken:              map[string]string{},
		channels:              map[string]domain.Channel{},
		dwells:                map[string]domain.PendingDwell{},
		maxPositionsPerDevice: 200_000,
	}
}

func (s *Store) Kind() string               { return "memory" }
func (s *Store) Ping(context.Context) error { return nil }
func (s *Store) Close() error               { return nil }

// ---------------------------------------------------------------- users

func (s *Store) GetUser(_ context.Context, id string) (domain.User, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[id]
	if !ok {
		return domain.User{}, fmt.Errorf("user %s: %w", id, domain.ErrNotFound)
	}
	return u, nil
}

func (s *Store) UpsertUser(_ context.Context, u domain.User) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if u.ID == "" {
		return fmt.Errorf("user id required: %w", domain.ErrInvalid)
	}
	if u.CreatedAt.IsZero() {
		u.CreatedAt = time.Now().UTC()
	}
	s.users[u.ID] = u
	return nil
}

func (s *Store) UpdateUserSettings(_ context.Context, id string, fn func(*domain.User)) (domain.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	u, ok := s.users[id]
	if !ok {
		return domain.User{}, fmt.Errorf("user %s: %w", id, domain.ErrNotFound)
	}
	fn(&u)
	u.ID = id
	s.users[id] = u
	return u, nil
}

// ---------------------------------------------------------------- devices

func (s *Store) ListDevices(_ context.Context, userID string) ([]domain.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Device, 0, len(s.devices))
	for _, d := range s.devices {
		if d.UserID == userID {
			out = append(out, cloneDevice(d))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (s *Store) GetDevice(_ context.Context, userID, id string) (domain.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[id]
	if !ok || d.UserID != userID {
		return domain.Device{}, fmt.Errorf("device %s: %w", id, domain.ErrNotFound)
	}
	return cloneDevice(d), nil
}

func (s *Store) DeviceByToken(_ context.Context, token string) (domain.Device, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.devToken[token]
	if !ok {
		return domain.Device{}, fmt.Errorf("device token: %w", domain.ErrUnauthorized)
	}
	return cloneDevice(s.devices[id]), nil
}

func (s *Store) UpsertDevice(_ context.Context, d domain.Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d.ID == "" || d.UserID == "" {
		return fmt.Errorf("device id and user id required: %w", domain.ErrInvalid)
	}
	if prev, ok := s.devices[d.ID]; ok {
		// Keep fields the caller did not supply (a device rename must not wipe
		// the ingest token or the last known fix).
		if d.Token == "" {
			d.Token = prev.Token
		}
		if d.LastPoint == nil {
			d.LastPoint, d.LastSeen, d.SpeedMPS, d.Battery = prev.LastPoint, prev.LastSeen, prev.SpeedMPS, prev.Battery
		}
		if d.CreatedAt.IsZero() {
			d.CreatedAt = prev.CreatedAt
		}
		if prev.Token != "" && prev.Token != d.Token {
			delete(s.devToken, prev.Token)
		}
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now().UTC()
	}
	if d.Token == "" {
		d.Token = idgen.Token()
	}
	s.devices[d.ID] = cloneDevice(d)
	s.devToken[d.Token] = d.ID
	return nil
}

func (s *Store) DeleteDevice(_ context.Context, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[id]
	if !ok || d.UserID != userID {
		return fmt.Errorf("device %s: %w", id, domain.ErrNotFound)
	}
	delete(s.devices, id)
	delete(s.devToken, d.Token)
	delete(s.positions, id)
	delete(s.posSeen, id)
	return nil
}

// TouchLastPoint implements the monotonic guard: the write only lands when the
// incoming fix is strictly newer than the stored one, so an offline replay
// cannot drag the live marker backwards (HLD §5.3).
func (s *Store) TouchLastPoint(_ context.Context, deviceID string, p domain.Point, ts time.Time, speedMPS float64, battery int) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	d, ok := s.devices[deviceID]
	if !ok {
		return false, fmt.Errorf("device %s: %w", deviceID, domain.ErrNotFound)
	}
	if d.LastSeen != nil && !ts.After(*d.LastSeen) {
		return false, nil
	}
	pt, seen, sp := p, ts.UTC(), speedMPS
	d.LastPoint, d.LastSeen, d.SpeedMPS = &pt, &seen, &sp
	if battery > 0 {
		b := battery
		d.Battery = &b
	}
	s.devices[deviceID] = d
	return true, nil
}

// ---------------------------------------------------------------- positions

func (s *Store) InsertPositions(_ context.Context, ps []domain.Position) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	written := 0
	touched := map[string]bool{}
	for _, p := range ps {
		if p.DeviceID == "" {
			return written, fmt.Errorf("position device id required: %w", domain.ErrInvalid)
		}
		key := p.RecvTS.UTC().UnixMicro()
		seen := s.posSeen[p.DeviceID]
		if seen == nil {
			seen = map[int64]struct{}{}
			s.posSeen[p.DeviceID] = seen
		}
		if _, dup := seen[key]; dup {
			continue // idempotent: the same (device, recv_ts) is a redelivery
		}
		seen[key] = struct{}{}
		s.positions[p.DeviceID] = append(s.positions[p.DeviceID], p)
		touched[p.DeviceID] = true
		written++
	}
	for dev := range touched {
		rows := s.positions[dev]
		sort.Slice(rows, func(i, j int) bool { return rows[i].RecvTS.Before(rows[j].RecvTS) })
		if over := len(rows) - s.maxPositionsPerDevice; over > 0 {
			for _, old := range rows[:over] {
				delete(s.posSeen[dev], old.RecvTS.UTC().UnixMicro())
			}
			rows = append([]domain.Position(nil), rows[over:]...)
		}
		s.positions[dev] = rows
	}
	return written, nil
}

func (s *Store) ListPositions(_ context.Context, userID string, q store.PositionQuery) ([]domain.Position, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var devices []string
	if q.DeviceID != "" {
		d, ok := s.devices[q.DeviceID]
		if !ok || d.UserID != userID {
			return nil, fmt.Errorf("device %s: %w", q.DeviceID, domain.ErrNotFound)
		}
		devices = []string{q.DeviceID}
	} else {
		for id, d := range s.devices {
			if d.UserID == userID {
				devices = append(devices, id)
			}
		}
	}
	out := []domain.Position{}
	for _, dev := range devices {
		for _, p := range s.positions[dev] {
			if !q.From.IsZero() && p.RecvTS.Before(q.From) {
				continue
			}
			if !q.To.IsZero() && p.RecvTS.After(q.To) {
				continue
			}
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RecvTS.Equal(out[j].RecvTS) {
			return out[i].DeviceID < out[j].DeviceID
		}
		return out[i].RecvTS.Before(out[j].RecvTS)
	})
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[len(out)-q.Limit:] // keep the most recent window
	}
	return out, nil
}

func (s *Store) LatestPosition(_ context.Context, userID, deviceID string) (domain.Position, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d, ok := s.devices[deviceID]
	if !ok || d.UserID != userID {
		return domain.Position{}, fmt.Errorf("device %s: %w", deviceID, domain.ErrNotFound)
	}
	rows := s.positions[deviceID]
	if len(rows) == 0 {
		return domain.Position{}, fmt.Errorf("positions for %s: %w", deviceID, domain.ErrNotFound)
	}
	return rows[len(rows)-1], nil
}

func (s *Store) DeletePositionsBefore(_ context.Context, userID string, before time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	deleted := 0
	for id, d := range s.devices {
		if d.UserID != userID {
			continue
		}
		kept := make([]domain.Position, 0, len(s.positions[id]))
		for _, p := range s.positions[id] {
			if p.RecvTS.Before(before) {
				delete(s.posSeen[id], p.RecvTS.UTC().UnixMicro())
				deleted++
				continue
			}
			kept = append(kept, p)
		}
		s.positions[id] = kept
	}
	return deleted, nil
}

// ---------------------------------------------------------------- places

func (s *Store) ListPlaces(_ context.Context, userID string) ([]domain.Place, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]domain.Place, 0, len(s.places))
	for _, p := range s.places {
		if p.UserID == userID {
			out = append(out, clonePlace(p))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	return out, nil
}

func (s *Store) GetPlace(_ context.Context, userID, id string) (domain.Place, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	p, ok := s.places[id]
	if !ok || p.UserID != userID {
		return domain.Place{}, fmt.Errorf("place %s: %w", id, domain.ErrNotFound)
	}
	return clonePlace(p), nil
}

func (s *Store) CreatePlace(_ context.Context, p domain.Place) (domain.Place, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if p.ID == "" {
		p.ID = idgen.New("plc")
	}
	if _, exists := s.places[p.ID]; exists {
		return domain.Place{}, fmt.Errorf("place %s: %w", p.ID, domain.ErrConflict)
	}
	now := time.Now().UTC()
	if p.CreatedAt.IsZero() {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	s.places[p.ID] = clonePlace(p)
	return clonePlace(p), nil
}

func (s *Store) UpdatePlace(_ context.Context, p domain.Place) (domain.Place, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.places[p.ID]
	if !ok || prev.UserID != p.UserID {
		return domain.Place{}, fmt.Errorf("place %s: %w", p.ID, domain.ErrNotFound)
	}
	p.CreatedAt = prev.CreatedAt
	p.UpdatedAt = time.Now().UTC()
	s.places[p.ID] = clonePlace(p)
	return clonePlace(p), nil
}

func (s *Store) DeletePlace(_ context.Context, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.places[id]
	if !ok || p.UserID != userID {
		return fmt.Errorf("place %s: %w", id, domain.ErrNotFound)
	}
	delete(s.places, id)
	// Notes bound to the place lose their binding rather than vanishing: the
	// text is the user's, the geofence was ours to delete.
	for nid, n := range s.notes {
		if n.PlaceID == id {
			n.PlaceID = ""
			n.UpdatedAt = time.Now().UTC()
			s.notes[nid] = n
		}
	}
	for k, d := range s.dwells {
		if d.PlaceID == id {
			delete(s.dwells, k)
		}
	}
	return nil
}

func (s *Store) PlacesContaining(_ context.Context, userID string, pt domain.Point) ([]domain.Place, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Place{}
	for _, p := range s.places {
		if p.UserID != userID {
			continue
		}
		// bbox pre-filter, then exact distance — mirrors GIST index + ST_DWithin
		if !geo.BBoxAround(p.Center.Lat, p.Center.Lon, float64(p.RadiusM)).Contains(pt.Lat, pt.Lon) {
			continue
		}
		if geo.DWithin(p.Center.Lat, p.Center.Lon, pt.Lat, pt.Lon, float64(p.RadiusM)) {
			out = append(out, clonePlace(p))
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func (s *Store) PlaceStats(_ context.Context, userID string) (map[string]store.PlaceStats, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string]store.PlaceStats{}
	for _, p := range s.places {
		if p.UserID == userID {
			out[p.ID] = store.PlaceStats{}
		}
	}
	for _, n := range s.notes {
		if n.UserID != userID || n.PlaceID == "" {
			continue
		}
		if st, ok := out[n.PlaceID]; ok {
			st.Notes++
			out[n.PlaceID] = st
		}
	}
	for _, e := range s.events {
		if e.UserID != userID {
			continue
		}
		if st, ok := out[e.PlaceID]; ok {
			st.Events++
			out[e.PlaceID] = st
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- notes

func (s *Store) ListNotes(_ context.Context, userID string, f store.NoteFilter) ([]domain.Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Note{}
	for _, n := range s.notes {
		if n.UserID != userID {
			continue
		}
		if f.PlaceID != "" && n.PlaceID != f.PlaceID {
			continue
		}
		if f.Trigger != "" && n.Trigger != f.Trigger {
			continue
		}
		if f.Done != nil && n.Done != *f.Done {
			continue
		}
		out = append(out, cloneNote(n))
	}
	// Open notes first (that is what the user needs to act on), oldest first
	// within each group — the order the mock's list shows.
	sort.Slice(out, func(i, j int) bool {
		if out[i].Done != out[j].Done {
			return !out[i].Done
		}
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID < out[j].ID
		}
		return out[i].CreatedAt.Before(out[j].CreatedAt)
	})
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

func (s *Store) GetNote(_ context.Context, userID, id string) (domain.Note, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n, ok := s.notes[id]
	if !ok || n.UserID != userID {
		return domain.Note{}, fmt.Errorf("note %s: %w", id, domain.ErrNotFound)
	}
	return cloneNote(n), nil
}

func (s *Store) CreateNote(_ context.Context, n domain.Note) (domain.Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n.ID == "" {
		n.ID = idgen.New("not")
	}
	if _, exists := s.notes[n.ID]; exists {
		return domain.Note{}, fmt.Errorf("note %s: %w", n.ID, domain.ErrConflict)
	}
	now := time.Now().UTC()
	if n.CreatedAt.IsZero() {
		n.CreatedAt = now
	}
	n.UpdatedAt = now
	s.notes[n.ID] = cloneNote(n)
	return cloneNote(n), nil
}

func (s *Store) UpdateNote(_ context.Context, n domain.Note) (domain.Note, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.notes[n.ID]
	if !ok || prev.UserID != n.UserID {
		return domain.Note{}, fmt.Errorf("note %s: %w", n.ID, domain.ErrNotFound)
	}
	n.CreatedAt = prev.CreatedAt
	if n.FiredAt == nil {
		n.FiredAt = prev.FiredAt
	}
	n.UpdatedAt = time.Now().UTC()
	s.notes[n.ID] = cloneNote(n)
	return cloneNote(n), nil
}

func (s *Store) DeleteNote(_ context.Context, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.notes[id]
	if !ok || n.UserID != userID {
		return fmt.Errorf("note %s: %w", id, domain.ErrNotFound)
	}
	delete(s.notes, id)
	return nil
}

func (s *Store) MarkNoteFired(_ context.Context, userID, id string, at time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	n, ok := s.notes[id]
	if !ok || n.UserID != userID {
		return fmt.Errorf("note %s: %w", id, domain.ErrNotFound)
	}
	t := at.UTC()
	n.FiredAt = &t
	n.UpdatedAt = t
	s.notes[id] = n
	return nil
}

// ---------------------------------------------------------------- shares

func (s *Store) ListShares(_ context.Context, userID string, includeInactive bool) ([]domain.Share, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UTC()
	out := []domain.Share{}
	for _, sh := range s.shares {
		if sh.UserID != userID {
			continue
		}
		if !includeInactive && !sh.Active(now) {
			continue
		}
		out = append(out, cloneShare(sh))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func (s *Store) CreateShare(_ context.Context, sh domain.Share) (domain.Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sh.ID == "" {
		sh.ID = idgen.New("shr")
	}
	if sh.Token == "" {
		sh.Token = idgen.ShortToken()
	}
	if _, exists := s.shares[sh.ID]; exists {
		return domain.Share{}, fmt.Errorf("share %s: %w", sh.ID, domain.ErrConflict)
	}
	if sh.CreatedAt.IsZero() {
		sh.CreatedAt = time.Now().UTC()
	}
	s.shares[sh.ID] = cloneShare(sh)
	s.shrToken[sh.Token] = sh.ID
	return cloneShare(sh), nil
}

func (s *Store) ShareByToken(_ context.Context, token string) (domain.Share, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, ok := s.shrToken[token]
	if !ok {
		return domain.Share{}, fmt.Errorf("share token: %w", domain.ErrNotFound)
	}
	return cloneShare(s.shares[id]), nil
}

func (s *Store) RevokeShare(_ context.Context, userID, id, reason string, at time.Time) (domain.Share, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	sh, ok := s.shares[id]
	if !ok || sh.UserID != userID {
		return domain.Share{}, fmt.Errorf("share %s: %w", id, domain.ErrNotFound)
	}
	if sh.RevokedAt == nil {
		t := at.UTC()
		sh.RevokedAt = &t
		sh.RevokeReason = reason
		s.shares[id] = sh
	}
	return cloneShare(sh), nil
}

func (s *Store) SharesForArrivePlace(_ context.Context, userID, placeID string) ([]domain.Share, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	now := time.Now().UTC()
	out := []domain.Share{}
	for _, sh := range s.shares {
		if sh.UserID == userID && sh.Mode == domain.ShareUntilArrive && sh.ArrivePlace == placeID && sh.Active(now) {
			out = append(out, cloneShare(sh))
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- channels

func (s *Store) ListChannels(_ context.Context, userID string) ([]domain.Channel, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.Channel{}
	for _, c := range s.channels {
		if c.UserID == userID {
			out = append(out, cloneChannel(c))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Priority == out[j].Priority {
			return out[i].CreatedAt.Before(out[j].CreatedAt)
		}
		return out[i].Priority < out[j].Priority
	})
	return out, nil
}

func (s *Store) CreateChannel(_ context.Context, c domain.Channel) (domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if c.ID == "" {
		c.ID = idgen.New("chn")
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	s.channels[c.ID] = cloneChannel(c)
	return cloneChannel(c), nil
}

func (s *Store) UpdateChannel(_ context.Context, c domain.Channel) (domain.Channel, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	prev, ok := s.channels[c.ID]
	if !ok || prev.UserID != c.UserID {
		return domain.Channel{}, fmt.Errorf("channel %s: %w", c.ID, domain.ErrNotFound)
	}
	c.CreatedAt = prev.CreatedAt
	s.channels[c.ID] = cloneChannel(c)
	return cloneChannel(c), nil
}

func (s *Store) DeleteChannel(_ context.Context, userID, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.channels[id]
	if !ok || c.UserID != userID {
		return fmt.Errorf("channel %s: %w", id, domain.ErrNotFound)
	}
	delete(s.channels, id)
	return nil
}

// ---------------------------------------------------------------- events

func (s *Store) InsertTriggerEvent(_ context.Context, e domain.TriggerEvent) (domain.TriggerEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.ID == "" {
		e.ID = idgen.New("evt")
	}
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	s.events = append(s.events, cloneEvent(e))
	if len(s.events) > 5000 {
		s.events = append([]domain.TriggerEvent(nil), s.events[len(s.events)-5000:]...)
	}
	return cloneEvent(e), nil
}

func (s *Store) ListTriggerEvents(_ context.Context, userID string, limit int) ([]domain.TriggerEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.TriggerEvent{}
	for i := len(s.events) - 1; i >= 0; i-- {
		if s.events[i].UserID != userID {
			continue
		}
		out = append(out, cloneEvent(s.events[i]))
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- dwell timers

func dwellKey(deviceID, placeID string) string { return deviceID + "|" + placeID }

func (s *Store) PutPendingDwell(_ context.Context, d domain.PendingDwell) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := dwellKey(d.DeviceID, d.PlaceID)
	// Re-arming an existing timer keeps the original entered_at: dwell measures
	// how long the device has been at the place, not when the engine last looked.
	// The SQL store expresses the same rule with ON CONFLICT DO UPDATE SET
	// fire_at only, and storetest asserts both agree.
	if prev, ok := s.dwells[key]; ok {
		d.EnteredAt = prev.EnteredAt
	}
	s.dwells[key] = d
	return nil
}

func (s *Store) DeletePendingDwell(_ context.Context, deviceID, placeID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.dwells, dwellKey(deviceID, placeID))
	return nil
}

func (s *Store) DuePendingDwells(_ context.Context, at time.Time) ([]domain.PendingDwell, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.PendingDwell{}
	for _, d := range s.dwells {
		if !d.FireAt.After(at) {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FireAt.Before(out[j].FireAt) })
	return out, nil
}

func (s *Store) ListPendingDwells(_ context.Context, userID string) ([]domain.PendingDwell, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.PendingDwell{}
	for _, d := range s.dwells {
		if d.UserID == userID {
			out = append(out, d)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].FireAt.Before(out[j].FireAt) })
	return out, nil
}

// ---------------------------------------------------------------- clones
//
// Everything handed out is a copy: callers routinely mutate what they read
// (the API layer patches a place before saving it), and shared backing arrays
// would let those edits leak into the store without a write.

func cloneDevice(d domain.Device) domain.Device {
	if d.LastPoint != nil {
		p := *d.LastPoint
		d.LastPoint = &p
	}
	if d.LastSeen != nil {
		t := *d.LastSeen
		d.LastSeen = &t
	}
	if d.SpeedMPS != nil {
		v := *d.SpeedMPS
		d.SpeedMPS = &v
	}
	if d.Battery != nil {
		v := *d.Battery
		d.Battery = &v
	}
	return d
}

func clonePlace(p domain.Place) domain.Place {
	p.Tags = cloneStrings(p.Tags)
	p.Triggers = append(make([]domain.Trigger, 0, len(p.Triggers)), p.Triggers...)
	return p
}

func cloneNote(n domain.Note) domain.Note {
	n.Tags = cloneStrings(n.Tags)
	if n.FiredAt != nil {
		t := *n.FiredAt
		n.FiredAt = &t
	}
	return n
}

func cloneShare(s domain.Share) domain.Share {
	s.DeviceIDs = cloneStrings(s.DeviceIDs)
	if s.ExpiresAt != nil {
		t := *s.ExpiresAt
		s.ExpiresAt = &t
	}
	if s.RevokedAt != nil {
		t := *s.RevokedAt
		s.RevokedAt = &t
	}
	return s
}

func cloneChannel(c domain.Channel) domain.Channel {
	cfg := make(map[string]string, len(c.Config))
	for k, v := range c.Config {
		cfg[k] = v
	}
	c.Config = cfg
	return c
}

func cloneEvent(e domain.TriggerEvent) domain.TriggerEvent {
	e.NoteIDs = cloneStrings(e.NoteIDs)
	e.Delivered = cloneStrings(e.Delivered)
	return e
}

// cloneStrings copies a slice and never returns nil, so JSON responses carry []
// rather than null. Clients should not have to handle two spellings of "empty".
func cloneStrings(in []string) []string {
	return append(make([]string, 0, len(in)), in...)
}

// compile-time assertion that the memory store satisfies the full contract
var _ store.Store = (*Store)(nil)
