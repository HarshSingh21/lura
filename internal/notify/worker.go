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

	notes, err := w.store.ListNotes(ctx, ev.UserID, store.NoteFilter{
		PlaceID: ev.PlaceID,
		Trigger: ev.Trigger,
		Done:    boolPtr(false),
	})
	if err != nil {
		span.SetStatus(codes.Error, "resolve notes")
		return fmt.Errorf("notify: resolve notes: %w", err)
	}

	user, err := w.store.GetUser(ctx, ev.UserID)
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		return fmt.Errorf("notify: load user: %w", err)
	}

	msg := w.render(ev, notes, user)
	span.SetAttributes(attribute.Int("lura.note_count", len(notes)))

	// Trigger history is recorded whether or not anything was delivered: the
	// place's trigger history is an audit trail, not a delivery log.
	event := domain.TriggerEvent{
		UserID:    ev.UserID,
		PlaceID:   ev.PlaceID,
		PlaceName: ev.PlaceName,
		DeviceID:  ev.DeviceID,
		Trigger:   ev.Trigger,
		TS:        ev.TS,
		NoteIDs:   noteIDs(notes),
	}

	// Quiet hours suppress *push*, never the in-app record: the user should
	// still find the reminder waiting in the morning.
	quiet := inQuietHours(user, w.now())
	if quiet {
		metrics.NotifyQuiet.Inc()
		span.SetAttributes(attribute.Bool("lura.quiet_hours", true))
	}

	delivered := w.deliver(ctx, msg, notes, quiet)
	event.Delivered = delivered

	if len(delivered) > 0 {
		metrics.NotifyDelivered.Inc(metrics.AttrTrigger.String(string(ev.Trigger)))
		metrics.NotifySeconds.Observe(w.now().Sub(ev.TS).Seconds(), metrics.AttrTrigger.String(string(ev.Trigger)))
		for _, n := range notes {
			if err := w.store.MarkNoteFired(ctx, ev.UserID, n.ID, w.now()); err != nil {
				w.log.WarnContext(ctx, "notify: mark note fired failed", "note", n.ID, "error", err)
			}
		}
	} else if len(notes) > 0 {
		metrics.NotifyFailed.Inc(metrics.AttrTrigger.String(string(ev.Trigger)))
		event.Note = "no channel accepted the message"
	}

	if _, err := w.store.InsertTriggerEvent(ctx, event); err != nil {
		w.log.WarnContext(ctx, "notify: record trigger event failed", "error", err)
	}
	return nil
}

// deliver walks the user's channels in priority order, retrying each with
// backoff and failing over to the next. It returns the channel types that
// accepted the message.
func (w *Worker) deliver(ctx context.Context, msg Message, notes []domain.Note, quiet bool) []string {
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

	// With nothing to remind about there is no reason to push.
	if len(notes) == 0 {
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

// render builds the human-facing message. One event with three matching notes
// becomes one message listing them, not three pings.
func (w *Worker) render(ev domain.GeoEvent, notes []domain.Note, user domain.User) Message {
	title := verbFor(ev.Trigger) + " " + ev.PlaceName
	var body string
	switch len(notes) {
	case 0:
		body = fmt.Sprintf("%s %s", verbFor(ev.Trigger), ev.PlaceName)
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

	click := ""
	if w.cfg.BaseURL != "" {
		click = w.cfg.BaseURL + "/places/" + ev.PlaceID
	}

	return Message{
		UserID:    ev.UserID,
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
	}
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
