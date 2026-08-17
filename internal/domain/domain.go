// Package domain holds Lura's core types. It has no dependencies on transport,
// storage or the message bus so every other package can share one vocabulary.
package domain

import (
	"errors"
	"strings"
	"time"
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
}

// Place is a geofence: a circle in Phase 1 (center + radius, evaluated with
// ST_DWithin), polygons in Phase 2.
type Place struct {
	ID        string    `json:"id"`
	UserID    string    `json:"userId"`
	Name      string    `json:"name"`
	Tags      []string  `json:"tags"`
	Center    Point     `json:"center"`
	RadiusM   int       `json:"radiusM"`
	Triggers  []Trigger `json:"triggers"`
	DwellMins int       `json:"dwellMins"` // for TriggerDwell, minutes inside before firing
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"` // drives AI embedding-cache invalidation (HLD §5.7)
}

// Note is a reminder bound to a place and a trigger.
type Note struct {
	ID        string     `json:"id"`
	UserID    string     `json:"userId"`
	Text      string     `json:"text"`
	PlaceID   string     `json:"placeId"`
	Trigger   Trigger    `json:"trigger"`
	Tags      []string   `json:"tags"`
	Done      bool       `json:"done"`
	Channel   string     `json:"channel"` // "" = user default channels
	CreatedAt time.Time  `json:"createdAt"`
	UpdatedAt time.Time  `json:"updatedAt"`
	FiredAt   *time.Time `json:"firedAt,omitempty"`
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
}

// GeoEvent is what the geofence engine publishes on geo.<user>. It is the
// contract between the geofence engine and the notification worker.
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
