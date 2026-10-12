// Package domain holds Lura's core types. It has no dependencies on transport,
// storage or the message bus so every other package can share one vocabulary.
// Its one internal import, geo, is pure math.
package domain

import (
	"errors"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/geo"
)

// Sentinel errors, mapped to HTTP status codes by the API layer.
var (
	ErrNotFound     = errors.New("not found")
	ErrConflict     = errors.New("conflict")
	ErrUnauthorized = errors.New("unauthorized")
	ErrForbidden    = errors.New("forbidden")
	ErrInvalid      = errors.New("invalid")
)

// Point is a WGS84 coordinate. Stored as PostGIS GEOGRAPHY(Point,4326).
type Point struct {
	Lat float64 `json:"lat"`
	Lon float64 `json:"lon"`
}

// Trigger is the event class that fires a note.
//
// HLD §5.4: arrive/leave are Tile38 enter/exit plus a debounce; dwell is a
// timer armed on enter; passby is enter-while-moving (place-level in Phase 1,
// route corridors in Phase 2 — see §5.5).
type Trigger string

const (
	TriggerArrive Trigger = "arrive"
	TriggerLeave  Trigger = "leave"
	TriggerDwell  Trigger = "dwell"
	TriggerPassby Trigger = "passby"
)

// ValidTrigger reports whether t is a trigger the geofence engine can evaluate.
func ValidTrigger(t Trigger) bool {
	switch t {
	case TriggerArrive, TriggerLeave, TriggerDwell, TriggerPassby:
		return true
	}
	return false
}

// Label renders a trigger the way the UI shows it ("Pass by", "On arrive").
func (t Trigger) Label() string {
	switch t {
	case TriggerArrive:
		return "On arrive"
	case TriggerLeave:
		return "On leave"
	case TriggerDwell:
		return "On dwell"
	case TriggerPassby:
		return "Pass by"
	}
	return string(t)
}

// User is an account. Phase 1 has a single seeded user behind a static token;
// Phase 2 sources these from Zitadel (HLD §5.10).
type User struct {
	ID          string    `json:"id"`
	Email       string    `json:"email"`
	DisplayName string    `json:"displayName"`
	Locale      string    `json:"locale"`
	TZ          string    `json:"tz"`
	QuietFrom   string    `json:"quietFrom"` // "22:00", empty = no quiet hours
	QuietTo     string    `json:"quietTo"`   // "07:00"
	Airgap      bool      `json:"airgap"`    // HLD §11: no outbound calls at all
	CreatedAt   time.Time `json:"createdAt"`
}

// Device is a tracked phone/watch/tracker belonging to a user.
type Device struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Name      string     `json:"name"`
	Kind      string     `json:"kind"` // phone | watch | tracker
	Token     string     `json:"-"`    // bearer secret used by /pub
	LastSeen  *time.Time `json:"lastSeen,omitempty"`
	LastPoint *Point     `json:"lastPoint,omitempty"`
	SpeedMPS  *float64   `json:"speedMps,omitempty"`
	Battery   *int       `json:"battery,omitempty"`
	CreatedAt time.Time  `json:"createdAt"`
}

// Position is one location fix.
//
// RecvTS (server clock) is authoritative for ordering and dedupe; DeviceTS is
// the device's own clock and is kept as data only (HLD §5.2, §6).
type Position struct {
	DeviceID  string    `json:"deviceId"`
	UserID    string    `json:"userId"`
	RecvTS    time.Time `json:"recvTs"`
	DeviceTS  time.Time `json:"deviceTs"`
	Point     Point     `json:"point"`
	AccuracyM float64   `json:"accuracyM"`
	SpeedMPS  float64   `json:"speedMps"`
	AltitudeM float64   `json:"altitudeM"`
	HeadingD  float64   `json:"headingDeg"`
	Battery   int       `json:"battery"`
	Seq       int64     `json:"seq"` // client sequence number, strengthens the idempotency key

	// Late marks a fix whose device clock is older than a fix this server has
	// already accepted for the device: a queued fix arriving out of order. It
	// is history — kept, never drawn, never evaluated against a fence — because
	// the live map and the inside-set must only ever move forwards.
	Late bool `json:"late,omitempty"`

	// FixTS is when the device was actually at Point, on the server's clock:
	// its own timestamp corrected by how far its clock runs from the server's
	// (learnt per device from fixes that arrive live). It equals RecvTS for a
	// fix sent as it was taken and is older for one a phone queued while it
	// had no network. Freshness — "is this news, or history?" — is judged by
	// it, so a phone replaying a tunnel's worth of fixes neither fires fences
	// nor shows up as "just now", while a laptop whose clock is ten minutes
	// out still counts as live.
	FixTS time.Time `json:"fixTs"`
}

// PlaceShape is the geometry a geofence uses.
type PlaceShape string

const (
	// ShapeCircle is center + radius, evaluated with ST_DWithin / haversine.
	ShapeCircle PlaceShape = "circle"
	// ShapePolygon is a drawn ring, evaluated with ST_Covers / ray casting.
	ShapePolygon PlaceShape = "polygon"
)

// Place is a geofence: a circle (center + radius, evaluated with ST_DWithin) or
// a polygon (evaluated with ST_Covers). A polygon still carries Center and
// RadiusM — the server-computed centroid and bounding radius — so listing,
// fitting the map and the spatial pre-filter treat both shapes the same way.
type Place struct {
	ID      string     `json:"id"`
	UserID  string     `json:"userId"`
	Name    string     `json:"name"`
	Tags    []string   `json:"tags"`
	Shape   PlaceShape `json:"shape"`
	Center  Point      `json:"center"`
	RadiusM int        `json:"radiusM"`
	// Polygon is an open ring (first vertex not repeated); empty for circles.
	Polygon []Point `json:"polygon"`
	// WatchUserIDs are connected people whose crossings of this fence notify the
	// owner. A crossing is only evaluated while that person shares live with the
	// owner, so the list is a wish, never an override of their consent.
	WatchUserIDs []string  `json:"watchUserIds"`
	Triggers     []Trigger `json:"triggers"`
	DwellMins    int       `json:"dwellMins"` // for TriggerDwell, minutes inside before firing
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"` // drives AI embedding-cache invalidation (HLD §5.7)
}

// IsPolygon reports whether the place is evaluated against its ring.
func (p Place) IsPolygon() bool { return p.Shape == ShapePolygon && len(p.Polygon) >= 3 }

// Contains is the in-process containment test: haversine for a circle,
// point-in-polygon for a ring (boundary inclusive, like ST_Covers). The memory
// store and the engine's restart path use it; PostGIS answers the same question
// in SQL.
func (p Place) Contains(pt Point) bool {
	if p.IsPolygon() {
		return geo.PointInPolygon(pt.Lat, pt.Lon, p.Ring())
	}
	return geo.DWithin(p.Center.Lat, p.Center.Lon, pt.Lat, pt.Lon, float64(p.RadiusM))
}

// Ring converts the polygon to the geo package's vertex type.
func (p Place) Ring() []geo.Vertex {
	out := make([]geo.Vertex, len(p.Polygon))
	for i, v := range p.Polygon {
		out[i] = geo.Vertex(v)
	}
	return out
}

// Watches reports whether userID is on the place's watch list.
func (p Place) Watches(userID string) bool {
	for _, id := range p.WatchUserIDs {
		if id == userID {
			return true
		}
	}
	return false
}

// Normalized fills the defaults every reader relies on: a shape, and empty
// (never nil) collections, so JSON carries [] rather than null and the two
// stores return identical values.
func (p Place) Normalized() Place {
	if p.Shape == "" {
		p.Shape = ShapeCircle
	}
	if p.Tags == nil {
		p.Tags = []string{}
	}
	if p.Polygon == nil || p.Shape == ShapeCircle {
		p.Polygon = []Point{}
	}
	if p.WatchUserIDs == nil {
		p.WatchUserIDs = []string{}
	}
	if p.Triggers == nil {
		p.Triggers = []Trigger{}
	}
	return p
}

// Note is a reminder bound to a place and a trigger.
type Note struct {
	ID      string   `json:"id"`
	UserID  string   `json:"userId"`
	Text    string   `json:"text"`
	PlaceID string   `json:"placeId"`
	Trigger Trigger  `json:"trigger"`
	Tags    []string `json:"tags"`
	Done    bool     `json:"done"`
	Channel string   `json:"channel"` // "" = user default channels
	// WatchUserID is whose movement fires the note: "" for the owner's own
	// devices, otherwise a connected peer who shares live with the owner.
	WatchUserID string `json:"watchUserId"`
	// NotifyUserIDs is who receives the reminder; empty means [owner]. Each id
	// is the owner or an accepted connection.
	NotifyUserIDs []string   `json:"notifyUserIds"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	FiredAt       *time.Time `json:"firedAt,omitempty"`
}

// Recipients resolves NotifyUserIDs, applying the "empty means the owner"
// default and dropping blanks and duplicates.
func (n Note) Recipients() []string {
	seen := make(map[string]bool, len(n.NotifyUserIDs))
	out := make([]string, 0, len(n.NotifyUserIDs))
	for _, id := range n.NotifyUserIDs {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	if len(out) == 0 {
		return []string{n.UserID}
	}
	return out
}

// Normalized makes the note's collections non-nil.
func (n Note) Normalized() Note {
	if n.Tags == nil {
		n.Tags = []string{}
	}
	if n.NotifyUserIDs == nil {
		n.NotifyUserIDs = []string{}
	}
	return n
}

// ConnectionStatus is where a mutual-sharing relationship stands.
type ConnectionStatus string

const (
	// ConnectionPendingOut is an invitation this user sent.
	ConnectionPendingOut ConnectionStatus = "pending_out"
	// ConnectionPendingIn is an invitation waiting on this user.
	ConnectionPendingIn ConnectionStatus = "pending_in"
	// ConnectionAccepted means both sides agreed.
	ConnectionAccepted ConnectionStatus = "accepted"
)

// Connection is one side of a mutual live-location relationship.
//
// HLD §2.1 asks for "mutual-consent group sharing", and the shape here is what
// makes the consent real: there is one row *per direction*, each owned by the
// person it belongs to. A row answers "what do I see, and what do I let them
// see?" — so either side can pause sharing without severing the relationship,
// and neither side can flip the other's switch.
//
// This is deliberately not the same thing as a Share: a Share is a link handed
// to someone who may have no account, and it is one-way. A Connection is two
// accounts agreeing to see each other.
type Connection struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	PeerID string `json:"peerId"`

	// Peer identity, cached so a listing does not need a join or a second
	// round trip to render.
	PeerName  string `json:"peerName"`
	PeerEmail string `json:"peerEmail"`

	Status ConnectionStatus `json:"status"`

	// Sharing is this side's own switch: whether *this* user's live position is
	// visible to the peer. The peer has an independent one.
	Sharing bool `json:"sharing"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// Live reports whether this row currently authorises the peer to watch this
// user's position.
func (c Connection) Live() bool { return c.Status == ConnectionAccepted && c.Sharing }

// ShareMode is how a share link ends.
type ShareMode string

const (
	ShareUntilArrive ShareMode = "until_arrive"
	ShareDuration    ShareMode = "duration"
	ShareUntilRevoke ShareMode = "until_revoke"
)

// Share is an expiring, revocable, read-only live view. No account needed to
// view it; nothing covert (HLD §5.8).
type Share struct {
	ID           string     `json:"id"`
	UserID       string     `json:"userId"`
	Token        string     `json:"token"`
	Label        string     `json:"label"` // "Priya", "Family group"
	Mode         ShareMode  `json:"mode"`
	DeviceIDs    []string   `json:"deviceIds"` // empty = all of the user's devices
	ExpiresAt    *time.Time `json:"expiresAt,omitempty"`
	ArrivePlace  string     `json:"arrivePlaceId,omitempty"` // for ShareUntilArrive
	RevokedAt    *time.Time `json:"revokedAt,omitempty"`
	RevokeReason string     `json:"revokeReason,omitempty"`
	CreatedAt    time.Time  `json:"createdAt"`
}

// Active reports whether the share still grants access at time now.
func (s Share) Active(now time.Time) bool {
	if s.RevokedAt != nil {
		return false
	}
	if s.ExpiresAt != nil && now.After(*s.ExpiresAt) {
		return false
	}
	return true
}

// Channel is a delivery route for reminders (ntfy, webhook, log, …).
type Channel struct {
	ID        string            `json:"id"`
	UserID    string            `json:"userId"`
	Type      string            `json:"type"`
	Config    map[string]string `json:"config"`
	Enabled   bool              `json:"enabled"`
	Priority  int               `json:"priority"` // lower is tried first; failover walks up
	CreatedAt time.Time         `json:"createdAt"`
}

// TriggerEvent is the audit trail of a fired (or suppressed) geofence event.
type TriggerEvent struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	PlaceID   string    `json:"placeId"`
	PlaceName string    `json:"placeName"`
	DeviceID  string    `json:"deviceId"`
	Trigger   Trigger   `json:"trigger"`
	TS        time.Time `json:"ts"`
	NoteIDs   []string  `json:"noteIds"`
	Delivered []string  `json:"delivered"` // channel types that accepted the message
	Note      string    `json:"note,omitempty"`

	// SubjectUserID/SubjectName say whose device crossed: the owner, or a
	// connected peer on a fence the owner watches them on.
	SubjectUserID string `json:"subjectUserId,omitempty"`
	SubjectName   string `json:"subjectName,omitempty"`

	// GeoEventID is the crossing this was recorded for — the GeoEvent id
	// (geo_…) that the WS geo frame and every reminder for it carry as
	// eventId — so a reminder can be joined to its crossing by id. Empty on
	// rows recorded before it was kept.
	GeoEventID string `json:"geoEventId,omitempty"`
}

// ReminderStatus is whether a delivered reminder still demands attention.
type ReminderStatus string

const (
	ReminderPending      ReminderStatus = "pending"
	ReminderAcknowledged ReminderStatus = "acknowledged"
)

// Reminder kinds.
const (
	// ReminderKindNote is a reminder about one or more notes.
	ReminderKindNote = "note"
	// ReminderKindWatch is "a person you watch crossed your fence".
	ReminderKindWatch = "watch"
	// ReminderKindAck tells a note's owner that a recipient acknowledged it.
	// It is stored already acknowledged: it informs, it does not nag.
	ReminderKindAck = "ack"
)

// ReminderRecord is one delivered reminder, stored per recipient so it keeps
// demanding attention until that recipient acknowledges it — across reloads,
// devices, sign-outs and server restarts.
type ReminderRecord struct {
	ID            string         `json:"id"`
	UserID        string         `json:"userId"`  // the recipient
	OwnerID       string         `json:"ownerId"` // owner of the note / place
	NoteIDs       []string       `json:"noteIds"`
	PlaceID       string         `json:"placeId"`
	PlaceName     string         `json:"placeName"`
	Trigger       Trigger        `json:"trigger"`
	Kind          string         `json:"kind"`
	Title         string         `json:"title"`
	Body          string         `json:"body"`
	SubjectUserID string         `json:"subjectUserId"`
	SubjectName   string         `json:"subjectName"`
	FromUserID    string         `json:"fromUserId,omitempty"`
	FromName      string         `json:"fromName,omitempty"`
	EventID       string         `json:"eventId"`
	CreatedAt     time.Time      `json:"createdAt"`
	Status        ReminderStatus `json:"status"`
	AckedAt       *time.Time     `json:"ackedAt,omitempty"`
	AckedBy       string         `json:"ackedBy,omitempty"`
}

// Normalized makes collections non-nil and fills the status default.
func (r ReminderRecord) Normalized() ReminderRecord {
	if r.NoteIDs == nil {
		r.NoteIDs = []string{}
	}
	if r.Status == "" {
		r.Status = ReminderPending
	}
	return r
}

// ConnectionAction is a change to a connection, as the activity feed shows it.
type ConnectionAction string

const (
	ConnectionActionInvited  ConnectionAction = "invited"
	ConnectionActionAccepted ConnectionAction = "accepted"
	ConnectionActionPaused   ConnectionAction = "paused"
	ConnectionActionResumed  ConnectionAction = "resumed"
	ConnectionActionRemoved  ConnectionAction = "removed"
)

// ConnectionEvent is one change to a relationship, recorded once per side
// (UserID is whose feed it belongs to; ActorID is who made the change).
type ConnectionEvent struct {
	ID       string           `json:"id"`
	UserID   string           `json:"userId"`
	PeerID   string           `json:"peerId"`
	PeerName string           `json:"peerName"`
	Action   ConnectionAction `json:"action"`
	ActorID  string           `json:"actorId"`
	TS       time.Time        `json:"ts"`
}

// GeoEvent is what the geofence engine publishes on geo.<user>. It is the
// contract between the geofence engine and the notification worker.
//
// UserID is always the *place owner* — the user whose subject it is published
// on — and SubjectUserID is whose device crossed. They differ when a connected
// peer crosses a fence the owner watches them on.
type GeoEvent struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	DeviceID  string    `json:"deviceId"`
	PlaceID   string    `json:"placeId"`
	PlaceName string    `json:"placeName"`
	Trigger   Trigger   `json:"trigger"`
	TS        time.Time `json:"ts"`
	Point     Point     `json:"point"`
	SpeedMPS  float64   `json:"speedMps"`

	SubjectUserID string `json:"subjectUserId"`
	SubjectName   string `json:"subjectName"`
}

// Subject returns whose device crossed, defaulting to the owner for an event
// published before the field existed.
func (e GeoEvent) Subject() string {
	if e.SubjectUserID == "" {
		return e.UserID
	}
	return e.SubjectUserID
}

// PendingDwell is an armed dwell timer. Persisted (not cache-only) so a
// restart cannot lose a pending reminder — HLD §17 lists cache-only dwell
// timers as a known risk, so Phase 1 keeps them in the store.
type PendingDwell struct {
	DeviceID  string    `json:"deviceId"`
	UserID    string    `json:"userId"`
	PlaceID   string    `json:"placeId"`
	FireAt    time.Time `json:"fireAt"`
	EnteredAt time.Time `json:"enteredAt"`
}

// Segment is one leg of a device's day: a stop or a movement.
type Segment struct {
	ID        string    `json:"id"`
	DeviceID  string    `json:"deviceId"`
	Kind      string    `json:"kind"` // stop | move
	Mode      string    `json:"mode"` // Stop | Walk | Cycle | Drive
	StartTS   time.Time `json:"startTs"`
	EndTS     time.Time `json:"endTs"`
	DistanceM float64   `json:"distanceM"`
	FromPlace string    `json:"fromPlace,omitempty"`
	ToPlace   string    `json:"toPlace,omitempty"`
	AtPlace   string    `json:"atPlace,omitempty"`
	Path      []Point   `json:"path"`
}

// Duration of the segment.
func (s Segment) Duration() time.Duration { return s.EndTS.Sub(s.StartTS) }

// Suggestion is the AI Brain's answer for a free-text note (HLD §5.7).
type Suggestion struct {
	Text       string   `json:"text"`
	Tags       []string `json:"tags"`
	PlaceID    string   `json:"placeId,omitempty"`
	PlaceName  string   `json:"placeName,omitempty"`
	Trigger    Trigger  `json:"trigger"`
	Confidence float64  `json:"confidence"`
	Engine     string   `json:"engine"` // "rules" (Phase 1) | "minilm" (Phase 2)
	OnDevice   bool     `json:"onDevice"`
}

// NormalizeTags lowercases, trims and de-duplicates tags, preserving order.
func NormalizeTags(in []string) []string {
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, t := range in {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}
