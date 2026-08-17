// Package store defines Lura's persistence contract.
//
// Two implementations exist:
//
//   - store/postgres — the real Phase 1 path: PostgreSQL + PostGIS (+ optional
//     TimescaleDB hypertable on positions), all spatial work pushed into SQL.
//   - store/memory — a dependency-free implementation used by tests and by
//     `lura -store=memory` for demos, with geo/ standing in for PostGIS.
//
// Every method is user-scoped: the API layer passes the authenticated user's ID
// and the store filters on it, so per-user isolation is enforced in the query
// itself rather than by convention (HLD §11).
package store

import (
	"context"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
)

// NoteFilter narrows a note listing.
type NoteFilter struct {
	PlaceID string
	Trigger domain.Trigger
	Done    *bool
	Limit   int
}

// PositionQuery selects a slice of a device's history.
type PositionQuery struct {
	DeviceID string
	From     time.Time
	To       time.Time
	Limit    int
}

// PlaceStats are the per-place counters the Places grid shows.
type PlaceStats struct {
	Notes  int `json:"notes"`
	Events int `json:"events"`
}

// UserStore covers accounts and their privacy/quiet-hour settings.
type UserStore interface {
	GetUser(ctx context.Context, id string) (domain.User, error)
	// FindUserByEmail backs "invite by email": it is the one user lookup that is
	// not scoped to the caller, so it returns only what an invite needs.
	FindUserByEmail(ctx context.Context, email string) (domain.User, error)
	UpsertUser(ctx context.Context, u domain.User) error
	UpdateUserSettings(ctx context.Context, id string, fn func(*domain.User)) (domain.User, error)
}

// DeviceStore covers tracked devices and their last known position.
type DeviceStore interface {
	ListDevices(ctx context.Context, userID string) ([]domain.Device, error)
	GetDevice(ctx context.Context, userID, id string) (domain.Device, error)
	// DeviceByToken resolves an ingest credential. It is the only lookup that
	// is not user-scoped, because /pub authenticates as a device.
	DeviceByToken(ctx context.Context, token string) (domain.Device, error)
	UpsertDevice(ctx context.Context, d domain.Device) error
	DeleteDevice(ctx context.Context, userID, id string) error
	// TouchLastPoint applies the monotonic last-position guard from HLD §5.3:
	// a late or replayed fix must never overwrite a newer one. It reports
	// whether the row was actually advanced.
	TouchLastPoint(ctx context.Context, deviceID string, p domain.Point, ts time.Time, speedMPS float64, battery int) (bool, error)
}

// PositionStore is the history write/read path.
type PositionStore interface {
	// InsertPositions is idempotent on (device_id, recv_ts) — the Phase 2
	// JetStream consumer redelivers, so writes must be safe to repeat
	// (HLD §5.2, §10). It returns the number of rows actually stored.
	InsertPositions(ctx context.Context, ps []domain.Position) (int, error)
	ListPositions(ctx context.Context, userID string, q PositionQuery) ([]domain.Position, error)
	LatestPosition(ctx context.Context, userID, deviceID string) (domain.Position, error)
	DeletePositionsBefore(ctx context.Context, userID string, before time.Time) (int, error)
}

// PlaceStore covers geofences.
type PlaceStore interface {
	ListPlaces(ctx context.Context, userID string) ([]domain.Place, error)
	GetPlace(ctx context.Context, userID, id string) (domain.Place, error)
	CreatePlace(ctx context.Context, p domain.Place) (domain.Place, error)
	UpdatePlace(ctx context.Context, p domain.Place) (domain.Place, error)
	DeletePlace(ctx context.Context, userID, id string) error
	// PlacesContaining returns every place whose circle contains the point.
	// PostGIS answers with ST_DWithin over a GIST index; the memory store
	// uses a bbox pre-filter plus a haversine check.
	PlacesContaining(ctx context.Context, userID string, p domain.Point) ([]domain.Place, error)
	PlaceStats(ctx context.Context, userID string) (map[string]PlaceStats, error)
}

// NoteStore covers reminders.
type NoteStore interface {
	ListNotes(ctx context.Context, userID string, f NoteFilter) ([]domain.Note, error)
	GetNote(ctx context.Context, userID, id string) (domain.Note, error)
	CreateNote(ctx context.Context, n domain.Note) (domain.Note, error)
	UpdateNote(ctx context.Context, n domain.Note) (domain.Note, error)
	DeleteNote(ctx context.Context, userID, id string) error
	MarkNoteFired(ctx context.Context, userID, id string, at time.Time) error
}

// ShareStore covers expiring share links.
type ShareStore interface {
	ListShares(ctx context.Context, userID string, includeInactive bool) ([]domain.Share, error)
	CreateShare(ctx context.Context, s domain.Share) (domain.Share, error)
	ShareByToken(ctx context.Context, token string) (domain.Share, error)
	RevokeShare(ctx context.Context, userID, id, reason string, at time.Time) (domain.Share, error)
	// SharesForArrivePlace finds the "until I arrive" shares that an arrive
	// event at placeID should auto-revoke (HLD §5.8).
	SharesForArrivePlace(ctx context.Context, userID, placeID string) ([]domain.Share, error)
}

// ConnectionStore covers mutual live-sharing relationships between accounts.
//
// Rows are per direction and each is owned by its UserID, so every read is
// user-scoped like the rest of the store: nobody can enumerate, or flip a switch
// on, a relationship they are not part of.
type ConnectionStore interface {
	ListConnections(ctx context.Context, userID string) ([]domain.Connection, error)
	GetConnection(ctx context.Context, userID, peerID string) (domain.Connection, error)
	UpsertConnection(ctx context.Context, c domain.Connection) (domain.Connection, error)
	DeleteConnection(ctx context.Context, userID, peerID string) error
}

// ChannelStore covers notification channels.
type ChannelStore interface {
	ListChannels(ctx context.Context, userID string) ([]domain.Channel, error)
	CreateChannel(ctx context.Context, c domain.Channel) (domain.Channel, error)
	UpdateChannel(ctx context.Context, c domain.Channel) (domain.Channel, error)
	DeleteChannel(ctx context.Context, userID, id string) error
}

// EventStore is the trigger audit trail.
type EventStore interface {
	InsertTriggerEvent(ctx context.Context, e domain.TriggerEvent) (domain.TriggerEvent, error)
	ListTriggerEvents(ctx context.Context, userID string, limit int) ([]domain.TriggerEvent, error)
}

// DwellStore persists armed dwell timers.
//
// HLD §17 flags cache-only dwell timers as a data-loss risk, so Phase 1 keeps
// them in the durable store and the engine reloads them on boot.
type DwellStore interface {
	PutPendingDwell(ctx context.Context, d domain.PendingDwell) error
	DeletePendingDwell(ctx context.Context, deviceID, placeID string) error
	DuePendingDwells(ctx context.Context, at time.Time) ([]domain.PendingDwell, error)
	ListPendingDwells(ctx context.Context, userID string) ([]domain.PendingDwell, error)
}

// Store is everything the monolith needs. Splitting it into per-aggregate
// interfaces keeps the Phase 2 service split mechanical: each extracted service
// depends on the sub-interface it actually uses.
type Store interface {
	UserStore
	DeviceStore
	PositionStore
	PlaceStore
	NoteStore
	ShareStore
	ConnectionStore
	ChannelStore
	EventStore
	DwellStore

	// Ping backs /readyz.
	Ping(ctx context.Context) error
	// Kind identifies the implementation ("postgres", "memory") for /healthz.
	Kind() string
	Close() error
}
