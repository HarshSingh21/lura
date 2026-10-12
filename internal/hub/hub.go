// Package hub is the live fan-out half of the API + WebSocket Gateway.
//
// HLD §5.1 folds fan-out into the Gateway: there is no separate fan-out service
// and no internal hop between "the thing subscribed to NATS" and "the thing that
// owns the socket". Each connection subscribes, through this hub, to exactly the
// subjects its viewer is authorized to see, and frames are pushed straight onto
// that connection's outbox.
//
// Two behaviours here are load-bearing:
//
//   - Backpressure is drop-to-latest for live positions. The live map only needs
//     the newest fix, so a slow client loses intermediate positions instead of
//     stalling the publisher or growing an unbounded buffer.
//   - Authorization is re-evaluated, never cached past a revoke. A share grant or
//     revoke publishes acl.<viewer>; the hub recomputes that viewer's subject set
//     and drops subscriptions immediately, so a revoked link stops receiving the
//     next fix rather than at the end of some TTL.
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/metrics"
)

// Frame is the envelope every WebSocket message uses. A single tagged shape
// keeps the client's handling a switch rather than a guess.
type Frame struct {
	Type    string          `json:"type"`
	Subject string          `json:"subject,omitempty"`
	TS      time.Time       `json:"ts"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Frame types.
const (
	FrameHello    = "hello"
	FramePosition = "position"
	FrameGeo      = "geo"
	FrameNotify   = "notify"
	FrameACL      = "acl"
	FrameError    = "error"
	FramePong     = "pong"
	FrameClosing  = "closing"
)

// SubjectResolver returns the subjects a viewer may currently see. It is called
// on connect and again on every ACL change for that viewer, so it must reflect
// live authorization state (revoked shares included) rather than a snapshot.
type SubjectResolver func(ctx context.Context) ([]string, error)

// Client is one live connection's view of the bus.
type Client struct {
	ID       string
	ViewerID string // user id, or "share:<token>" for an unauthenticated viewer

	hub      *Hub
	resolve  SubjectResolver
	out      chan []byte
	done     chan struct{}
	closeOne sync.Once

	mu   sync.Mutex
	subs map[string]bus.Subscription
}

// Out is the outbox the transport writes to the socket from.
func (c *Client) Out() <-chan []byte { return c.out }

// Done is closed when the client is torn down.
func (c *Client) Done() <-chan struct{} { return c.done }

// Subjects returns the client's current subscription list (for /healthz and
// tests).
func (c *Client) Subjects() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.subs))
	for s := range c.subs {
		out = append(out, s)
	}
	return out
}

// Hub owns every live connection on this replica.
type Hub struct {
	b   bus.Bus
	log *slog.Logger

	mu      sync.RWMutex
	clients map[string]*Client
	aclSub  bus.Subscription

	// outboxSize bounds each connection's queue before drop-to-latest kicks in.
	outboxSize int

	// recent keeps the last few geo events and reminders per subject, so a
	// client that was offline when its fence fired can be told on reconnect
	// (Replay). Positions are not kept: the snapshot already says where
	// everyone is now, and an old position is not news.
	recentMu  sync.Mutex
	recent    map[string][]recentFrame
	recentSub []bus.Subscription
}

// recentFrame is one reliable frame as it was published.
type recentFrame struct {
	ts      time.Time
	kind    string
	subject string
	data    []byte
}

// Replay limits: enough to cover a phone in a lift or a laptop lid closed over
// lunch, not a history API (that is /api/v1/events).
const (
	ReplayWindow     = 15 * time.Minute
	replayPerSubject = 50
)

// Option configures a Hub.
type Option func(*Hub)

// WithOutboxSize sets the per-connection queue depth.
func WithOutboxSize(n int) Option {
	return func(h *Hub) {
		if n > 0 {
			h.outboxSize = n
		}
	}
}

// New returns a Hub subscribed to the ACL control subject.
func New(b bus.Bus, log *slog.Logger, opts ...Option) (*Hub, error) {
	if log == nil {
		log = slog.Default()
	}
	h := &Hub{b: b, log: log, clients: map[string]*Client{}, outboxSize: 64}
	for _, o := range opts {
		o(h)
	}

	// One hub-wide subscription to acl.* rather than one per client: ACL events
	// are rare and the hub already knows which clients belong to which viewer.
	sub, err := b.Subscribe("acl.*", func(m bus.Msg) {
		viewer := bus.UserKey(m)
		h.onACL(viewer, m.Data)
	})
	if err != nil {
		return nil, err
	}
	h.aclSub = sub

	h.recent = map[string][]recentFrame{}
	for _, pattern := range []string{bus.GeoAll(), bus.NotifyAll()} {
		rs, err := b.Subscribe(pattern, h.remember)
		if err != nil {
			sub.Unsubscribe()
			for _, x := range h.recentSub {
				x.Unsubscribe()
			}
			return nil, err
		}
		h.recentSub = append(h.recentSub, rs)
	}
	return h, nil
}

// remember files a geo event or reminder for Replay.
func (h *Hub) remember(m bus.Msg) {
	now := time.Now().UTC()
	f := recentFrame{ts: now, kind: frameTypeFor(m.Subject), subject: m.Subject, data: append([]byte(nil), m.Data...)}
	h.recentMu.Lock()
	defer h.recentMu.Unlock()
	list := append(h.recent[m.Subject], f)
	// Drop what has aged out or overflowed; the list is in arrival order.
	cut := 0
	for cut < len(list) && (now.Sub(list[cut].ts) > ReplayWindow || len(list)-cut > replayPerSubject) {
		cut++
	}
	h.recent[m.Subject] = list[cut:]
}

// Replay sends a reconnecting client the geo events and reminders published
// on its subjects after `since` (the time of the last frame it saw), in the
// order they happened, stamped with their original time. The client dedupes
// by event id, so overlap with frames it already has is harmless; what
// matters is that a crossing that fired while it was offline is not lost.
func (h *Hub) Replay(c *Client, since time.Time) int {
	if since.IsZero() {
		return 0
	}
	subjects := c.Subjects()
	var out []recentFrame
	h.recentMu.Lock()
	for _, subject := range subjects {
		for _, f := range h.recent[subject] {
			if f.ts.After(since) && time.Since(f.ts) <= ReplayWindow {
				out = append(out, f)
			}
		}
	}
	h.recentMu.Unlock()
	sort.SliceStable(out, func(i, j int) bool { return out[i].ts.Before(out[j].ts) })
	for _, f := range out {
		c.enqueueAt(f.kind, f.subject, f.data, false, f.ts)
	}
	return len(out)
}

// Connect registers a new connection and performs its first subscribe.
func (h *Hub) Connect(ctx context.Context, viewerID string, resolve SubjectResolver) (*Client, error) {
	if resolve == nil {
		return nil, errors.New("hub: subject resolver required")
	}
	c := &Client{
		ID:       idgen.New("cli"),
		ViewerID: viewerID,
		hub:      h,
		resolve:  resolve,
		out:      make(chan []byte, h.outboxSize),
		done:     make(chan struct{}),
		subs:     map[string]bus.Subscription{},
	}

	h.mu.Lock()
	h.clients[c.ID] = c
	h.mu.Unlock()
	metrics.WSConnections.Add(1)

	if err := c.resubscribe(ctx); err != nil {
		h.Disconnect(c)
		return nil, err
	}

	h.Hello(c, nil)
	return c, nil
}

// Disconnect tears a client down: unsubscribes everything, then closes the
// outbox so the transport's write loop exits.
func (h *Hub) Disconnect(c *Client) {
	if c == nil {
		return
	}
	h.mu.Lock()
	delete(h.clients, c.ID)
	h.mu.Unlock()

	c.closeOne.Do(func() {
		c.mu.Lock()
		for subject, sub := range c.subs {
			sub.Unsubscribe()
			delete(c.subs, subject)
		}
		c.mu.Unlock()
		close(c.done)
		metrics.WSConnections.Add(-1)
	})
}

// Count reports the number of live connections on this replica.
func (h *Hub) Count() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Close disconnects every client, e.g. during shutdown.
func (h *Hub) Close() {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.clients))
	for _, c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.Unlock()
	for _, c := range clients {
		c.enqueue(FrameClosing, "", []byte(`{"reason":"server shutting down"}`), false)
		h.Disconnect(c)
	}
	if h.aclSub != nil {
		h.aclSub.Unsubscribe()
	}
	for _, x := range h.recentSub {
		x.Unsubscribe()
	}
}

// onACL re-evaluates authorization for every connection belonging to viewer.
func (h *Hub) onACL(viewer string, payload []byte) {
	h.mu.RLock()
	var affected []*Client
	for _, c := range h.clients {
		if c.ViewerID == viewer {
			affected = append(affected, c)
		}
	}
	h.mu.RUnlock()

	if len(affected) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, c := range affected {
		if err := c.resubscribe(ctx); err != nil {
			h.log.Warn("hub: acl resubscribe failed, dropping connection",
				"client", c.ID, "viewer", viewer, "error", err)
			h.Disconnect(c)
			continue
		}
		c.enqueue(FrameACL, bus.ACLSubject(viewer), payload, false)
	}
}

// Resubscribe re-runs the resolver for one client. Exported so the API layer can
// force a refresh (e.g. right after the owner revokes a share on this replica).
func (c *Client) Resubscribe(ctx context.Context) error { return c.resubscribe(ctx) }

func (c *Client) resubscribe(ctx context.Context) error {
	want, err := c.resolve(ctx)
	if err != nil {
		return err
	}
	wanted := make(map[string]struct{}, len(want))
	for _, s := range want {
		if s != "" {
			wanted[s] = struct{}{}
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Drop what is no longer authorized first: a revoke must take effect even if
	// adding the new subscriptions fails.
	for subject, sub := range c.subs {
		if _, keep := wanted[subject]; !keep {
			sub.Unsubscribe()
			delete(c.subs, subject)
		}
	}
	for subject := range wanted {
		if _, exists := c.subs[subject]; exists {
			continue
		}
		s := subject // captured per subscription
		sub, err := c.hub.b.Subscribe(s, func(m bus.Msg) {
			c.enqueue(frameTypeFor(m.Subject), m.Subject, m.Data, frameTypeFor(m.Subject) == FramePosition)
		})
		if err != nil {
			return err
		}
		c.subs[subject] = sub
	}
	return nil
}

// enqueue puts a frame on the client's outbox.
//
// live=true selects drop-to-latest: when the outbox is full the oldest frame is
// discarded to make room for the newest, because a stale position is worthless.
// live=false is used for geo events, reminders and ACL changes, which are
// dropped only as a last resort and counted when they are.
func (c *Client) enqueue(kind, subject string, data []byte, live bool) {
	c.enqueueAt(kind, subject, data, live, time.Now().UTC())
}

// enqueueAt is enqueue with the frame's time given: a replayed frame keeps the
// time it was first published.
func (c *Client) enqueueAt(kind, subject string, data []byte, live bool, ts time.Time) {
	frame := Frame{Type: kind, Subject: subject, TS: ts, Data: data}
	buf, err := json.Marshal(frame)
	if err != nil {
		return
	}

	select {
	case <-c.done:
		return
	default:
	}

	select {
	case c.out <- buf:
		metrics.WSSent.Inc()
		return
	default:
	}

	if live {
		// Make room by discarding the oldest queued frame, then retry once.
		select {
		case <-c.out:
			metrics.WSDropped.Inc()
		default:
		}
		select {
		case c.out <- buf:
			metrics.WSSent.Inc()
		default:
			metrics.WSDropped.Inc()
		}
		return
	}

	// Reliable frame: give the writer a moment to catch up before giving up.
	select {
	case c.out <- buf:
		metrics.WSSent.Inc()
	case <-time.After(250 * time.Millisecond):
		metrics.WSDropped.Inc()
		c.hub.log.Warn("hub: dropped reliable frame, client too slow",
			"client", c.ID, "viewer", c.ViewerID, "type", kind)
	case <-c.done:
	}
}

// Hello sends the initial frame describing the connection.
func (h *Hub) Hello(c *Client, extra map[string]any) {
	payload := map[string]any{
		"clientId": c.ID,
		"viewerId": c.ViewerID,
		"subjects": c.Subjects(),
	}
	for k, v := range extra {
		payload[k] = v
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	c.enqueue(FrameHello, "", data, false)
}

// Send pushes an arbitrary frame to one client (used for pongs and errors).
func (h *Hub) Send(c *Client, kind string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	c.enqueue(kind, "", data, false)
}

func frameTypeFor(subject string) string {
	switch {
	case strings.HasPrefix(subject, "pos."):
		return FramePosition
	case strings.HasPrefix(subject, "geo."):
		return FrameGeo
	case strings.HasPrefix(subject, "notify."):
		return FrameNotify
	case strings.HasPrefix(subject, "acl."):
		return FrameACL
	default:
		return subject
	}
}
