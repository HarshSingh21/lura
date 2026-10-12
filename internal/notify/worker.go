package notify

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/obs"
	"github.com/HarshSingh21/locnot/internal/store"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

// Config tunes delivery.
type Config struct {
	Tries      int           // attempts per channel before failing over
	RetryDelay time.Duration // base delay; doubles per attempt
	Airgap     bool          // refuse every notifier that declares egress
	BaseURL    string        // used to build the click-through URL
}

func (c Config) withDefaults() Config {
	if c.Tries <= 0 {
		c.Tries = 3
	}
	if c.RetryDelay <= 0 {
		c.RetryDelay = 500 * time.Millisecond
	}
	return c
}

// Worker consumes geo events and delivers the reminders they match.
type Worker struct {
	store store.Store
	b     bus.Bus
	log   *slog.Logger
	cfg   Config
	now   func() time.Time

	mu        sync.RWMutex
	notifiers map[string]Notifier

	sub  bus.Subscription
	once sync.Once
}

// NewWorker returns an unstarted worker. The notifiers are indexed by Type();
// channel rows in the store select among them by type.
func NewWorker(st store.Store, b bus.Bus, log *slog.Logger, cfg Config, notifiers ...Notifier) *Worker {
	if log == nil {
		log = slog.Default()
	}
	w := &Worker{
		store:     st,
		b:         b,
		log:       log,
		cfg:       cfg.withDefaults(),
		now:       time.Now,
		notifiers: map[string]Notifier{},
	}
	for _, n := range notifiers {
		if n != nil {
			w.notifiers[n.Type()] = n
		}
	}
	return w
}

// WithClock overrides the clock (tests).
func (w *Worker) WithClock(now func() time.Time) *Worker {
	w.now = now
	return w
}

// Register adds or replaces a notifier at runtime.
func (w *Worker) Register(n Notifier) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.notifiers[n.Type()] = n
}

// SetAirgap flips the egress ban at runtime, so the UI's airgap switch takes
// effect on the next reminder rather than on the next restart.
func (w *Worker) SetAirgap(on bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.cfg.Airgap = on
}

// Start subscribes to the durable geo-event stream, partitioned per user so one
// user's reminders are delivered in order.
func (w *Worker) Start(ctx context.Context) error {
	sub, err := w.b.SubscribePartitioned(bus.GeoAll(), 2, bus.UserKey, func(m bus.Msg) {
		var ev domain.GeoEvent
		if err := json.Unmarshal(m.Data, &ev); err != nil {
			w.log.Error("notify: undecodable geo event", "subject", m.Subject, "error", err)
			return
		}
		if err := w.Handle(context.WithoutCancel(ctx), ev); err != nil {
			w.log.Error("notify: handle failed", "event", ev.ID, "error", err)
		}
	})
	if err != nil {
		return err
	}
	w.sub = sub
	return nil
}

// Stop unsubscribes the worker.
func (w *Worker) Stop() {
	w.once.Do(func() {
		if w.sub != nil {
			w.sub.Unsubscribe()
		}
	})
}

// Handle resolves and delivers one geo event. Exported so tests (and a future
// "replay this event" admin action) can drive it directly.
func (w *Worker) Handle(ctx context.Context, ev domain.GeoEvent) error {
	ctx, span := obs.Start(ctx, "notify.handle", trace.WithAttributes(
		attribute.String("lura.trigger", string(ev.Trigger)),
		attribute.String("lura.place_id", ev.PlaceID),
	))
	defer span.End()

	owner := ev.UserID
	subject := ev.Subject()
	peerCrossing := subject != owner

	open, err := w.store.ListNotes(ctx, owner, store.NoteFilter{
		PlaceID: ev.PlaceID,
		Trigger: ev.Trigger,
		Done:    boolPtr(false),
	})
	if err != nil {
		span.SetStatus(codes.Error, "resolve notes")
		return fmt.Errorf("notify: resolve notes: %w", err)
	}
	// A note fires on one person's movement: the owner's own ("") or the one
	// peer it watches. Harsh's "buy milk when Nishtha passes" must not fire
	// when Harsh walks past, and his own "buy eggs" must not fire for her.
	whose := ""
	if peerCrossing {
		whose = subject
	}
	notes := make([]domain.Note, 0, len(open))
	for _, n := range open {
		if n.WatchUserID == whose {
			notes = append(notes, n)
		}
	}

	ownerUser, err := w.store.GetUser(ctx, owner)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("notify: load user: %w", err)
	}
	if ev.SubjectName == "" {
		ev.SubjectName = w.nameOf(ctx, subject)
	}

	deliveries := w.plan(ctx, ev, notes, peerCrossing)
	span.SetAttributes(
		attribute.Int("lura.note_count", len(notes)),
		attribute.Int("lura.recipient_count", len(deliveries)),
		attribute.Bool("lura.peer_crossing", peerCrossing),
	)

	// Trigger history is recorded whether or not anything was delivered: the
	// place's trigger history is an audit trail, not a delivery log. It is the
	// owner's: it is their place.
	event := domain.TriggerEvent{
		UserID:    owner,
		PlaceID:   ev.PlaceID,
		PlaceName: ev.PlaceName,
		DeviceID:  ev.DeviceID,
		Trigger:   ev.Trigger,
		TS:        ev.TS,
		NoteIDs:   noteIDs(notes),
		Delivered: []string{},

		SubjectUserID: subject,
		SubjectName:   ev.SubjectName,
	}

	seenChannel := map[string]bool{}
	firedNotes := map[string]bool{}
	for _, d := range deliveries {
		user := ownerUser
		if d.recipient != owner {
			u, err := w.store.GetUser(ctx, d.recipient)
			if err != nil && !errors.Is(err, domain.ErrNotFound) {
				w.log.WarnContext(ctx, "notify: load recipient failed", "recipient", d.recipient, "error", err)
				continue
			}
			user = u
		}

		msg := w.render(ev, d.notes, ownerUser, d.recipient, d.kind)

		// Quiet hours are the recipient's own, never the owner's: suppress
		// *push*, never the in-app record, so the reminder is waiting in the
		// morning.
		quiet := inQuietHours(user, w.now())
		if quiet {
			metrics.NotifyQuiet.Inc()
			span.SetAttributes(attribute.Bool("lura.quiet_hours", true))
		}

		push := len(d.notes) > 0 || d.kind == KindWatch

		// Stored before it is published: a reminder that reaches a screen
		// must already be acknowledgeable, and one that reaches no screen
		// (no session open, quiet hours) must be waiting on the next load.
		if push {
			rec, err := w.store.SaveReminder(ctx, recordFor(msg, ev, owner))
			if err != nil {
				w.log.WarnContext(ctx, "notify: store reminder failed", "recipient", d.recipient, "error", err)
			} else {
				msg = withRecord(msg, rec)
			}
		}

		delivered := w.deliver(ctx, msg, d.notes, push, quiet)
		for _, c := range delivered {
			if !seenChannel[c] {
				seenChannel[c] = true
				event.Delivered = append(event.Delivered, c)
			}
		}
		if len(delivered) > 0 {
			for _, n := range d.notes {
				firedNotes[n.ID] = true
			}
		}
	}

	if len(event.Delivered) > 0 {
		metrics.NotifyDelivered.Inc(metrics.AttrTrigger.String(string(ev.Trigger)))
		metrics.NotifySeconds.Observe(w.now().Sub(ev.TS).Seconds(), metrics.AttrTrigger.String(string(ev.Trigger)))
	}
	for _, n := range notes {
		if !firedNotes[n.ID] {
			continue
		}
		if err := w.store.MarkNoteFired(ctx, owner, n.ID, w.now()); err != nil {
			w.log.WarnContext(ctx, "notify: mark note fired failed", "note", n.ID, "error", err)
		}
	}
	if len(notes) > 0 && len(firedNotes) == 0 {
		metrics.NotifyFailed.Inc(metrics.AttrTrigger.String(string(ev.Trigger)))
		event.Note = "no channel accepted the message"
	}

	if _, err := w.store.InsertTriggerEvent(ctx, event); err != nil {
		w.log.WarnContext(ctx, "notify: record trigger event failed", "error", err)
	}
	return nil
}

// Reminder kinds, carried on the wire as Message.Kind.
const (
	// KindNote is a reminder about notes (or the owner's own crossing).
	KindNote = "note"
	// KindWatch is "a person you watch crossed your fence", with no note.
	KindWatch = "watch"
)

// delivery is one recipient's share of an event.
type delivery struct {
	recipient string
	notes     []domain.Note
	kind      string
}

// plan decides who hears about an event and with which notes.
//
//   - Each note goes to its recipients (empty = the owner). A recipient other
//     than the owner must still be an accepted connection of the owner at
//     delivery time: removing someone stops your notes reaching them, even
//     notes written while you were connected.
//   - The owner's own crossing always produces a message for the owner, notes
//     or not — that is the live toast — exactly as before.
//   - A watched peer's crossing produces a kind:"watch" message for the owner
//     when no note already tells them about it, so one crossing is one ping.
//
// Recipients are returned in a stable order: the owner first, then the rest in
// the order the notes name them.
func (w *Worker) plan(ctx context.Context, ev domain.GeoEvent, notes []domain.Note, peerCrossing bool) []delivery {
	owner := ev.UserID
	var order []string
	byRecipient := map[string][]domain.Note{}
	allowed := map[string]bool{owner: true}

	add := func(r string) {
		if _, ok := byRecipient[r]; !ok {
			byRecipient[r] = nil
			order = append(order, r)
		}
	}

	for _, n := range notes {
		for _, r := range n.Recipients() {
			ok, checked := allowed[r]
			if !checked {
				ok = w.connected(ctx, owner, r)
				allowed[r] = ok
			}
			if !ok {
				w.log.InfoContext(ctx, "notify: recipient is not connected, skipped",
					"note", n.ID, "recipient", r)
				continue
			}
			add(r)
			byRecipient[r] = append(byRecipient[r], n)
		}
	}

	ownerKind := KindNote
	if _, ownerHasNotes := byRecipient[owner]; !ownerHasNotes {
		switch {
		case !peerCrossing:
			add(owner)
		case w.placeWatches(ctx, owner, ev.PlaceID, ev.Subject()):
			add(owner)
			ownerKind = KindWatch
		}
	}

	// Owner first: the person whose fence it is hears first.
	out := make([]delivery, 0, len(order))
	if _, ok := byRecipient[owner]; ok {
		out = append(out, delivery{recipient: owner, notes: byRecipient[owner], kind: ownerKind})
	}
	for _, r := range order {
		if r == owner {
			continue
		}
		out = append(out, delivery{recipient: r, notes: byRecipient[r], kind: KindNote})
	}
	return out
}

// connected reports whether recipient is an accepted connection of owner.
func (w *Worker) connected(ctx context.Context, owner, recipient string) bool {
	c, err := w.store.GetConnection(ctx, owner, recipient)
	if err != nil {
		return false
	}
	return c.Status == domain.ConnectionAccepted
}

func (w *Worker) placeWatches(ctx context.Context, owner, placeID, subject string) bool {
	p, err := w.store.GetPlace(ctx, owner, placeID)
	if err != nil {
		return false
	}
	return p.Watches(subject)
}

func (w *Worker) nameOf(ctx context.Context, userID string) string {
	u, err := w.store.GetUser(ctx, userID)
	if err != nil {
		return ""
	}
	return displayName(u)
}

func displayName(u domain.User) string {
	if u.DisplayName != "" {
		return u.DisplayName
	}
	return u.Email
}

// deliver walks the recipient's channels in priority order, retrying each with
// backoff and failing over to the next. It returns the channel types that
// accepted the message. push=false keeps it in-app only.
func (w *Worker) deliver(ctx context.Context, msg Message, notes []domain.Note, push, quiet bool) []string {
	w.mu.RLock()
	airgap := w.cfg.Airgap
	available := make(map[string]Notifier, len(w.notifiers))
	for k, v := range w.notifiers {
		available[k] = v
	}
	w.mu.RUnlock()

	// The in-app channel is always attempted: it is how the live UI shows the
	// reminder, it never leaves the box, and it ignores quiet hours because it
	// makes no sound.
	var delivered []string
	if n, ok := available["inapp"]; ok {
		if err := n.Send(ctx, msg); err != nil {
			w.log.WarnContext(ctx, "notify: in-app publish failed", "error", err)
		} else {
			delivered = append(delivered, n.Type())
		}
	}

	// With nothing to remind about there is no reason to push. A watch
	// reminder is the exception: the crossing itself is what was asked for.
	if !push {
		return delivered
	}
	if quiet {
		return delivered
	}

	channels, err := w.store.ListChannels(ctx, msg.UserID)
	if err != nil {
		w.log.WarnContext(ctx, "notify: list channels failed", "error", err)
	}

	// A note can pin itself to one channel type; otherwise every enabled channel
	// is a candidate, tried in priority order until one accepts.
	pinned := map[string]bool{}
	for _, n := range notes {
		if n.Channel != "" {
			pinned[n.Channel] = true
		}
	}

	candidates := make([]domain.Channel, 0, len(channels))
	for _, c := range channels {
		if !c.Enabled || c.Type == "inapp" {
			continue
		}
		if len(pinned) > 0 && !pinned[c.Type] {
			continue
		}
		candidates = append(candidates, c)
	}
	sort.SliceStable(candidates, func(i, j int) bool { return candidates[i].Priority < candidates[j].Priority })

	for _, ch := range candidates {
		n, ok := available[ch.Type]
		if !ok {
			w.log.WarnContext(ctx, "notify: no notifier for channel type", "type", ch.Type)
			continue
		}
		if airgap && n.Egress() {
			w.log.InfoContext(ctx, "notify: channel skipped in airgap mode", "type", ch.Type)
			continue
		}
		if err := w.sendWithRetry(ctx, n, w.applyChannelConfig(msg, ch)); err != nil {
			w.log.WarnContext(ctx, "notify: channel failed, failing over",
				"type", ch.Type, "error", err)
			continue
		}
		delivered = append(delivered, n.Type())
		return delivered // first channel that accepts wins; no duplicate pings
	}

	// Nothing configured (or everything failed): make sure the reminder is at
	// least recorded somewhere a human can find it.
	if len(candidates) == 0 {
		if n, ok := available["log"]; ok {
			if err := n.Send(ctx, msg); err == nil {
				delivered = append(delivered, n.Type())
			}
		}
	}
	return delivered
}

// applyChannelConfig lets a channel row override presentation details without
// the worker having to know each notifier's shape.
func (w *Worker) applyChannelConfig(msg Message, ch domain.Channel) Message {
	if v := ch.Config["title"]; v != "" {
		msg.Title = v
	}
	if v := ch.Config["priority"]; v != "" {
		if p, err := strconv.Atoi(v); err == nil && p >= 1 && p <= 5 {
			msg.Priority = p
		}
	}
	return msg
}

func (w *Worker) sendWithRetry(ctx context.Context, n Notifier, msg Message) error {
	delay := w.cfg.RetryDelay
	var last error
	for attempt := 1; attempt <= w.cfg.Tries; attempt++ {
		attemptCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := n.Send(attemptCtx, msg)
		cancel()
		if err == nil {
			return nil
		}
		last = err
		if attempt == w.cfg.Tries {
			break
		}
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return ctx.Err()
		}
		delay *= 2
	}
	metrics.NotifyFailed.Inc(metrics.AttrChannel.String(n.Type()))
	return last
}

// render builds the human-facing message for one recipient. One event with
// three matching notes becomes one message listing them, not three pings.
//
// The title is written from the recipient's point of view: the person who
// crossed reads "Arrived at Grocery", everyone else reads "Nishtha arrived at
// Grocery".
func (w *Worker) render(ev domain.GeoEvent, notes []domain.Note, owner domain.User, recipient, kind string) Message {
	title := verbFor(ev.Trigger) + " " + ev.PlaceName
	if ev.Subject() != recipient {
		name := ev.SubjectName
		if name == "" {
			name = "Someone"
		}
		title = name + " " + peerVerbFor(ev.Trigger) + " " + ev.PlaceName
	}
	var body string
	switch len(notes) {
	case 0:
		body = title
	case 1:
		body = notes[0].Text
	default:
		lines := make([]string, 0, len(notes))
		for _, n := range notes {
			lines = append(lines, "• "+n.Text)
		}
		body = strings.Join(lines, "\n")
	}

	tags := map[string]bool{}
	for _, n := range notes {
		for _, t := range n.Tags {
			tags[t] = true
		}
	}
	tagList := make([]string, 0, len(tags))
	for t := range tags {
		tagList = append(tagList, t)
	}
	sort.Strings(tagList)

	priority := 3
	if ev.Trigger == domain.TriggerPassby {
		// Pass-by is time-critical: the user is driving past the shop right now.
		priority = 4
	}

	// Deep-link to the live map rather than a per-place route the client does
	// not have: a push notification that opens a 404 is worse than one that
	// opens the map.
	click := ""
	if w.cfg.BaseURL != "" {
		click = w.cfg.BaseURL + "/"
	}

	msg := Message{
		UserID:    recipient,
		Title:     title,
		Body:      body,
		Trigger:   ev.Trigger,
		PlaceID:   ev.PlaceID,
		PlaceName: ev.PlaceName,
		DeviceID:  ev.DeviceID,
		NoteIDs:   noteIDs(notes),
		Tags:      tagList,
		Priority:  priority,
		ClickURL:  click,
		TS:        ev.TS,
		Event:     ev,
		Kind:      kind,
	}
	// Someone else's note or fence: say whose, so "buy milk" from Harsh does not
	// read like a reminder Nishtha wrote herself.
	if recipient != ev.UserID {
		msg.FromUserID = ev.UserID
		msg.FromName = displayName(owner)
	}
	return msg
}

func verbFor(t domain.Trigger) string {
	switch t {
	case domain.TriggerArrive:
		return "Arrived at"
	case domain.TriggerLeave:
		return "Left"
	case domain.TriggerDwell:
		return "Still at"
	case domain.TriggerPassby:
		return "Passing"
	}
	return string(t)
}

// peerVerbFor is the verb after a person's name: "Nishtha arrived at Grocery".
// It must read exactly like the client's own wording for the geo frame of the
// same crossing (VERB in client/src/features/notify/model.ts): the toast the geo
// frame raised is re-titled by this reminder, and a different verb makes it
// visibly flick from "passed by" to "passed".
func peerVerbFor(t domain.Trigger) string {
	switch t {
	case domain.TriggerArrive:
		return "arrived at"
	case domain.TriggerLeave:
		return "left"
	case domain.TriggerDwell:
		return "is still at"
	case domain.TriggerPassby:
		return "passed by"
	}
	return string(t)
}

// inQuietHours evaluates the user's quiet window in the user's own timezone,
// handling windows that wrap midnight (22:00 → 07:00).
func inQuietHours(u domain.User, now time.Time) bool {
	if u.QuietFrom == "" || u.QuietTo == "" {
		return false
	}
	loc := time.UTC
	if u.TZ != "" {
		if l, err := time.LoadLocation(u.TZ); err == nil {
			loc = l
		}
	}
	local := now.In(loc)
	from, okFrom := parseHM(u.QuietFrom)
	to, okTo := parseHM(u.QuietTo)
	if !okFrom || !okTo {
		return false
	}
	mins := local.Hour()*60 + local.Minute()
	if from == to {
		return false
	}
	if from < to {
		return mins >= from && mins < to
	}
	return mins >= from || mins < to // wraps midnight
}

func parseHM(s string) (int, bool) {
	parts := strings.Split(strings.TrimSpace(s), ":")
	if len(parts) != 2 {
		return 0, false
	}
	var h, m int
	if _, err := fmt.Sscanf(parts[0], "%d", &h); err != nil {
		return 0, false
	}
	if _, err := fmt.Sscanf(parts[1], "%d", &m); err != nil {
		return 0, false
	}
	if h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

func noteIDs(notes []domain.Note) []string {
	out := make([]string, 0, len(notes))
	for _, n := range notes {
		out = append(out, n.ID)
	}
	return out
}

func boolPtr(b bool) *bool { return &b }
