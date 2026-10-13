// Package activity builds a user's history as one timeline: their own trips
// and stops, crossings of their fences, the reminders they received (and
// acknowledged), and changes to their connections and share links.
//
// Everything is read from the store, so the feed is the same after signing in
// again or a server restart. Privacy follows the sources: every read is scoped
// to the viewer, positions are only ever the viewer's own devices, and a
// peer's movement appears only as the fence events and reminders the viewer
// was already entitled to — never as a track.
package activity

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/history"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Limits.
const (
	DefaultLimit = 200
	MaxLimit     = 1000
	// positionsPerDevice bounds one device's fixes read for a window: a day of
	// 20-second fixes is ~4300.
	positionsPerDevice = 20000
)

// Item types.
const (
	TypeTrip       = "trip"
	TypeStop       = "stop"
	TypeGeo        = "geo"
	TypeReminder   = "reminder"
	TypeAck        = "ack"
	TypeConnection = "connection"
	TypeShare      = "share"
)

// TripItem is a movement of one of the viewer's devices. TS is its start.
type TripItem struct {
	Type       string         `json:"type"`
	ID         string         `json:"id"`
	TS         time.Time      `json:"ts"`
	DeviceID   string         `json:"deviceId"`
	DeviceName string         `json:"deviceName"`
	Mode       string         `json:"mode"`
	StartTS    time.Time      `json:"startTs"`
	EndTS      time.Time      `json:"endTs"`
	DistanceM  float64        `json:"distanceM"`
	FromPlace  string         `json:"fromPlace,omitempty"`
	ToPlace    string         `json:"toPlace,omitempty"`
	Path       []domain.Point `json:"path"`
}

// StopItem is a stay of one of the viewer's devices. TS is its start.
type StopItem struct {
	Type       string        `json:"type"`
	ID         string        `json:"id"`
	TS         time.Time     `json:"ts"`
	DeviceID   string        `json:"deviceId"`
	DeviceName string        `json:"deviceName"`
	StartTS    time.Time     `json:"startTs"`
	EndTS      time.Time     `json:"endTs"`
	AtPlace    string        `json:"atPlace,omitempty"`
	Point      *domain.Point `json:"point,omitempty"`
}

// GeoItem is a crossing of one of the viewer's fences — by their own device or
// a connected person's on a fence they watch.
type GeoItem struct {
	Type string    `json:"type"`
	ID   string    `json:"id"`
	TS   time.Time `json:"ts"`
	// EventID names the crossing the way the WS geo frame and its reminders
	// do (the GeoEvent id, geo_…), so a reminder joins its crossing by id.
	// Rows recorded before that id was kept fall back to TriggerEventID.
	EventID string `json:"eventId"`
	// TriggerEventID is the stored trigger-history row (evt_…).
	TriggerEventID string         `json:"triggerEventId"`
	PlaceID        string         `json:"placeId"`
	PlaceName      string         `json:"placeName"`
	Trigger        domain.Trigger `json:"trigger"`
	DeviceID       string         `json:"deviceId"`
	SubjectUserID  string         `json:"subjectUserId"`
	SubjectName    string         `json:"subjectName"`
	NoteIDs        []string       `json:"noteIds"`
	Delivered      []string       `json:"delivered"`
}

// ReminderItem is a reminder the viewer received, with its current ack state.
type ReminderItem struct {
	Type     string                `json:"type"`
	ID       string                `json:"id"`
	TS       time.Time             `json:"ts"`
	Reminder domain.ReminderRecord `json:"reminder"`
}

// AckItem is an acknowledgement: the viewer's own (ByMe), or a person they
// sent a note to acknowledging it.
type AckItem struct {
	Type        string    `json:"type"`
	ID          string    `json:"id"`
	TS          time.Time `json:"ts"`
	ReminderID  string    `json:"reminderId"`
	Title       string    `json:"title"`
	Body        string    `json:"body"`
	PlaceName   string    `json:"placeName"`
	NoteIDs     []string  `json:"noteIds"`
	AckedBy     string    `json:"ackedBy"`
	AckedByName string    `json:"ackedByName"`
	ByMe        bool      `json:"byMe"`
}

// ConnectionItem is a change to one of the viewer's connections.
type ConnectionItem struct {
	Type     string                  `json:"type"`
	ID       string                  `json:"id"`
	TS       time.Time               `json:"ts"`
	Action   domain.ConnectionAction `json:"action"`
	PeerID   string                  `json:"peerId"`
	PeerName string                  `json:"peerName"`
	ByMe     bool                    `json:"byMe"`
}

// ShareItem is a share link the viewer created or that ended.
type ShareItem struct {
	Type    string           `json:"type"`
	ID      string           `json:"id"`
	TS      time.Time        `json:"ts"`
	Action  string           `json:"action"` // created | revoked
	ShareID string           `json:"shareId"`
	Label   string           `json:"label"`
	Mode    domain.ShareMode `json:"mode"`
	Reason  string           `json:"reason,omitempty"`
}

// Query selects a window. Zero To is now; zero From is To minus 24 hours.
type Query struct {
	From  time.Time
	To    time.Time
	Limit int
}

// Result is the feed: items newest first.
type Result struct {
	Items []any     `json:"items"`
	From  time.Time `json:"from"`
	To    time.Time `json:"to"`
}

// Service builds feeds.
type Service struct {
	store   store.Store
	history *history.Service
	now     func() time.Time
}

// New returns a feed builder. hist may be nil, in which case a default
// segmenter over the same store is used.
func New(st store.Store, hist *history.Service) *Service {
	if hist == nil {
		hist = history.New(st, nil, history.Config{})
	}
	return &Service{store: st, history: hist, now: time.Now}
}

// WithClock overrides the clock (tests).
func (s *Service) WithClock(now func() time.Time) *Service {
	s.now = now
	return s
}

type entry struct {
	ts   time.Time
	id   string
	item any
}

// Feed returns the viewer's merged timeline for the window.
func (s *Service) Feed(ctx context.Context, userID string, q Query) (Result, error) {
	if q.To.IsZero() {
		q.To = s.now().UTC()
	}
	if q.From.IsZero() {
		q.From = q.To.Add(-24 * time.Hour)
	}
	if q.From.After(q.To) {
		return Result{}, fmt.Errorf("activity: from after to: %w", domain.ErrInvalid)
	}
	if q.Limit <= 0 {
		q.Limit = DefaultLimit
	}
	if q.Limit > MaxLimit {
		q.Limit = MaxLimit
	}
	q.From, q.To = q.From.UTC(), q.To.UTC()
	window := store.RangeQuery{From: q.From, To: q.To, Limit: q.Limit}

	var out []entry
	add := func(ts time.Time, id string, item any) {
		if ts.Before(q.From) || ts.After(q.To) {
			return
		}
		out = append(out, entry{ts: ts, id: id, item: item})
	}

	// ---- trips and stops: the viewer's own devices only.
	devices, err := s.store.ListDevices(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	for _, d := range devices {
		sum, err := s.history.Summarise(ctx, userID, history.Query{
			DeviceID: d.ID, From: q.From, To: q.To, Limit: positionsPerDevice,
		})
		if err != nil {
			return Result{}, err
		}
		for _, seg := range sum.Segments {
			id := seg.Kind + ":" + d.ID + ":" + strconv.FormatInt(seg.StartTS.UnixMilli(), 10)
			switch seg.Kind {
			case "move":
				add(seg.StartTS, id, TripItem{
					Type: TypeTrip, ID: id, TS: seg.StartTS.UTC(), DeviceID: d.ID, DeviceName: d.Name,
					Mode: seg.Mode, StartTS: seg.StartTS.UTC(), EndTS: seg.EndTS.UTC(), DistanceM: seg.DistanceM,
					FromPlace: seg.FromPlace, ToPlace: seg.ToPlace, Path: nonNil(seg.Path),
				})
			case "stop":
				add(seg.StartTS, id, StopItem{
					Type: TypeStop, ID: id, TS: seg.StartTS.UTC(), DeviceID: d.ID, DeviceName: d.Name,
					StartTS: seg.StartTS.UTC(), EndTS: seg.EndTS.UTC(), AtPlace: seg.AtPlace, Point: centroid(seg.Path),
				})
			}
		}
	}

	// The reminders the viewer received, read first: they also say which of a
	// connected person's crossings the viewer was told about.
	reminders, err := s.store.ListReminders(ctx, userID, store.ReminderFilter{From: q.From, To: q.To, Limit: q.Limit * 2})
	if err != nil {
		return Result{}, err
	}
	told := map[string]bool{}
	for _, r := range reminders {
		if r.EventID != "" {
			told[r.EventID] = true
		}
	}
	places, err := s.store.ListPlaces(ctx, userID)
	if err != nil {
		return Result{}, err
	}
	watches := map[string]domain.Place{}
	for _, p := range places {
		watches[p.ID] = p
	}

	// ---- fence crossings on the viewer's places.
	events, err := s.store.TriggerEventsBetween(ctx, userID, window)
	if err != nil {
		return Result{}, err
	}
	for _, e := range events {
		subject := e.SubjectUserID
		if subject == "" {
			subject = e.UserID
		}
		if subject != userID && !entitled(e, watches, told) {
			continue
		}
		id := "geo:" + e.ID
		crossing := e.GeoEventID
		if crossing == "" {
			crossing = e.ID
		}
		add(e.TS, id, GeoItem{
			Type: TypeGeo, ID: id, TS: e.TS.UTC(), EventID: crossing, TriggerEventID: e.ID,
			PlaceID: e.PlaceID, PlaceName: e.PlaceName,
			Trigger: e.Trigger, DeviceID: e.DeviceID, SubjectUserID: subject, SubjectName: e.SubjectName,
			NoteIDs: nonNilStrings(e.NoteIDs), Delivered: nonNilStrings(e.Delivered),
		})
	}

	// ---- reminders received, and acknowledgements.
	myName := ""
	if u, err := s.store.GetUser(ctx, userID); err == nil {
		myName = u.DisplayName
		if myName == "" {
			myName = u.Email
		}
	}
	for _, r := range reminders {
		if r.Kind == domain.ReminderKindAck {
			// Someone acknowledged the viewer's note.
			id := "ack:" + r.ID
			add(r.CreatedAt, id, AckItem{
				Type: TypeAck, ID: id, TS: r.CreatedAt.UTC(), ReminderID: r.ID, Title: r.Title, Body: r.Body,
				PlaceName: r.PlaceName, NoteIDs: nonNilStrings(r.NoteIDs),
				AckedBy: r.AckedBy, AckedByName: r.FromName, ByMe: false,
			})
			continue
		}
		id := "reminder:" + r.ID
		add(r.CreatedAt, id, ReminderItem{Type: TypeReminder, ID: id, TS: r.CreatedAt.UTC(), Reminder: r})
		if r.AckedAt != nil {
			id := "ack:" + r.ID
			add(*r.AckedAt, id, AckItem{
				Type: TypeAck, ID: id, TS: r.AckedAt.UTC(), ReminderID: r.ID, Title: r.Title, Body: r.Body,
				PlaceName: r.PlaceName, NoteIDs: nonNilStrings(r.NoteIDs),
				AckedBy: userID, AckedByName: myName, ByMe: true,
			})
		}
	}

	// ---- connection changes.
	conns, err := s.store.ListConnectionEvents(ctx, userID, window)
	if err != nil {
		return Result{}, err
	}
	for _, c := range conns {
		id := "connection:" + c.ID
		add(c.TS, id, ConnectionItem{
			Type: TypeConnection, ID: id, TS: c.TS.UTC(), Action: c.Action,
			PeerID: c.PeerID, PeerName: c.PeerName, ByMe: c.ActorID == userID,
		})
	}

	// ---- share links.
	shares, err := s.store.ListShares(ctx, userID, true)
	if err != nil {
		return Result{}, err
	}
	for _, sh := range shares {
		id := "share:" + sh.ID + ":created"
		add(sh.CreatedAt, id, ShareItem{
			Type: TypeShare, ID: id, TS: sh.CreatedAt.UTC(), Action: "created",
			ShareID: sh.ID, Label: sh.Label, Mode: sh.Mode,
		})
		ended, reason := sh.RevokedAt, sh.RevokeReason
		if ended == nil && sh.ExpiresAt != nil && !sh.ExpiresAt.After(s.now()) {
			// Expired, but nothing recorded it: the in-process timer and the
			// sweeper only end links while this process is running, so a link
			// that ran out across a restart has no revocation row. It is over
			// all the same (Share.Active), and its history must say so.
			ended, reason = sh.ExpiresAt, "expired"
		}
		if ended != nil {
			id := "share:" + sh.ID + ":revoked"
			add(*ended, id, ShareItem{
				Type: TypeShare, ID: id, TS: ended.UTC(), Action: "revoked",
				ShareID: sh.ID, Label: sh.Label, Mode: sh.Mode, Reason: reason,
			})
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].ts.Equal(out[j].ts) {
			return out[i].id > out[j].id
		}
		return out[i].ts.After(out[j].ts)
	})
	if len(out) > q.Limit {
		out = out[:q.Limit]
	}
	items := make([]any, 0, len(out))
	for _, e := range out {
		items = append(items, e.item)
	}
	return Result{Items: items, From: q.From, To: q.To}, nil
}

// entitled says whether the viewer may see a connected person's crossing of
// one of the viewer's fences (release spec §7: "only as events the user was
// entitled to"). They may when the fence watches that person, or when the
// viewer was told about this crossing (a reminder carries its id). A fence that
// fired only because a note is about the person, and the note tells only them,
// is not the viewer's to see: "pick up keys, notify only Nishtha" leaves Harsh
// with her acknowledgement, not a record of where she went. A row recorded
// before crossings kept their id cannot be matched to what the viewer was told,
// so it stands as it always did.
func entitled(e domain.TriggerEvent, places map[string]domain.Place, told map[string]bool) bool {
	if e.GeoEventID == "" || told[e.GeoEventID] {
		return true
	}
	p, ok := places[e.PlaceID]
	return ok && p.Watches(e.SubjectUserID)
}

func centroid(path []domain.Point) *domain.Point {
	if len(path) == 0 {
		return nil
	}
	var c domain.Point
	for _, p := range path {
		c.Lat += p.Lat
		c.Lon += p.Lon
	}
	c.Lat /= float64(len(path))
	c.Lon /= float64(len(path))
	return &c
}

func nonNil(p []domain.Point) []domain.Point {
	if p == nil {
		return []domain.Point{}
	}
	return p
}

func nonNilStrings(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}
