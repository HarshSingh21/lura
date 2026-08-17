package notify_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// recorder is a Notifier that records what it was asked to send, and can be told
// to fail — which is how failover and retry get tested without a network.
type recorder struct {
	typ    string
	egress bool

	mu       sync.Mutex
	messages []notify.Message
	failures int // fail this many times before succeeding
}

func (r *recorder) Type() string { return r.typ }
func (r *recorder) Egress() bool { return r.egress }

func (r *recorder) Send(_ context.Context, m notify.Message) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.failures > 0 {
		r.failures--
		return errors.New("simulated channel failure")
	}
	r.messages = append(r.messages, m)
	return nil
}

func (r *recorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.messages)
}

func (r *recorder) last() notify.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.messages) == 0 {
		return notify.Message{}
	}
	return r.messages[len(r.messages)-1]
}

type fixture struct {
	store *memory.Store
	bus   *bus.InProcess
	place domain.Place
}

func newFixture(t *testing.T, user domain.User) *fixture {
	t.Helper()
	ctx := context.Background()
	st := memory.New()
	if user.ID == "" {
		user = domain.User{ID: "u1", TZ: "UTC"}
	}
	if err := st.UpsertUser(ctx, user); err != nil {
		t.Fatalf("UpsertUser: %v", err)
	}
	place, err := st.CreatePlace(ctx, domain.Place{
		ID: "p_shop", UserID: user.ID, Name: "Whole Foods",
		Center: domain.Point{Lat: 12.9611, Lon: 77.6387}, RadiusM: 60,
		Triggers: []domain.Trigger{domain.TriggerPassby},
	})
	if err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	return &fixture{store: st, bus: b, place: place}
}

func (f *fixture) note(t *testing.T, text string, trigger domain.Trigger, done bool) domain.Note {
	t.Helper()
	n, err := f.store.CreateNote(context.Background(), domain.Note{
		UserID: "u1", Text: text, PlaceID: f.place.ID, Trigger: trigger,
		Tags: []string{"grocery"}, Done: done,
	})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	return n
}

func (f *fixture) channel(t *testing.T, typ string, priority int) {
	t.Helper()
	if _, err := f.store.CreateChannel(context.Background(), domain.Channel{
		UserID: "u1", Type: typ, Enabled: true, Priority: priority,
	}); err != nil {
		t.Fatalf("CreateChannel(%s): %v", typ, err)
	}
}

func geoEvent(trigger domain.Trigger, placeID string) domain.GeoEvent {
	return domain.GeoEvent{
		ID: "geo_1", UserID: "u1", DeviceID: "d1", PlaceID: placeID,
		PlaceName: "Whole Foods", Trigger: trigger, TS: time.Now().UTC(),
	}
}

// A geo event delivers exactly the open notes for that place and trigger — not
// the done ones, not the ones on another trigger.
func TestDeliversMatchingOpenNotes(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.note(t, "eggs", domain.TriggerPassby, false)
	f.note(t, "already bought", domain.TriggerPassby, true)
	f.note(t, "different trigger", domain.TriggerArrive, false)
	f.channel(t, "push", 10)

	push := &recorder{typ: "push"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	if push.count() != 1 {
		t.Fatalf("push sent %d messages, want 1 (notes are batched into one)", push.count())
	}
	msg := push.last()
	if len(msg.NoteIDs) != 2 {
		t.Errorf("message covers %d notes, want 2", len(msg.NoteIDs))
	}
	if !strings.Contains(msg.Body, "oat milk") || !strings.Contains(msg.Body, "eggs") {
		t.Errorf("body missing note text: %q", msg.Body)
	}
	if strings.Contains(msg.Body, "already bought") {
		t.Errorf("body includes a completed note: %q", msg.Body)
	}

	// Matched notes are stamped as fired, which is what the UI shows.
	notes, err := f.store.ListNotes(context.Background(), "u1", store.NoteFilter{})
	if err != nil {
		t.Fatalf("ListNotes: %v", err)
	}
	fired := 0
	for _, n := range notes {
		if n.FiredAt != nil {
			fired++
		}
	}
	if fired != 2 {
		t.Errorf("%d notes stamped as fired, want 2", fired)
	}
}

// Quiet hours suppress push but never the in-app record: the reminder should be
// waiting in the morning, it just must not wake anyone up.
func TestQuietHoursSuppressPushButNotInApp(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC", QuietFrom: "22:00", QuietTo: "07:00"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "push", 10)

	push := &recorder{typ: "push"}
	inapp := &recorder{typ: "inapp"}
	night := time.Date(2026, 3, 1, 23, 30, 0, 0, time.UTC)
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push, inapp).
		WithClock(func() time.Time { return night })

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if push.count() != 0 {
		t.Errorf("push fired during quiet hours")
	}
	if inapp.count() != 1 {
		t.Errorf("in-app notification suppressed during quiet hours")
	}

	// Outside the window, push happens.
	push2 := &recorder{typ: "push"}
	day := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	w2 := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push2).
		WithClock(func() time.Time { return day })
	if err := w2.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if push2.count() != 1 {
		t.Errorf("push suppressed outside quiet hours")
	}
}

// Quiet hours are evaluated in the user's own timezone, and the window wraps
// midnight.
func TestQuietHoursUseUserTimezone(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "Asia/Kolkata", QuietFrom: "22:00", QuietTo: "07:00"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "push", 10)

	// 19:00 UTC is 00:30 next day in Kolkata: inside the window.
	push := &recorder{typ: "push"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push).
		WithClock(func() time.Time { return time.Date(2026, 3, 1, 19, 0, 0, 0, time.UTC) })
	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if push.count() != 0 {
		t.Error("push fired at 00:30 local, inside the user's quiet hours")
	}

	// 06:00 UTC is 11:30 in Kolkata: outside.
	push2 := &recorder{typ: "push"}
	w2 := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push2).
		WithClock(func() time.Time { return time.Date(2026, 3, 1, 6, 0, 0, 0, time.UTC) })
	if err := w2.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if push2.count() != 1 {
		t.Error("push suppressed at 11:30 local, outside quiet hours")
	}
}

// A failing channel must fail over to the next by priority, and only one channel
// should ultimately deliver — nobody wants the same reminder twice.
func TestFailoverToNextChannel(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "primary", 1)
	f.channel(t, "backup", 2)

	primary := &recorder{typ: "primary", failures: 99} // always fails
	backup := &recorder{typ: "backup"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 2, RetryDelay: time.Millisecond}, primary, backup)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if primary.count() != 0 {
		t.Error("primary reported a delivery it did not make")
	}
	if backup.count() != 1 {
		t.Fatalf("backup delivered %d messages, want 1", backup.count())
	}
}

// A transient failure is retried on the same channel rather than immediately
// failing over.
func TestRetryOnSameChannel(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "primary", 1)
	f.channel(t, "backup", 2)

	primary := &recorder{typ: "primary", failures: 1} // fails once, then works
	backup := &recorder{typ: "backup"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 3, RetryDelay: time.Millisecond}, primary, backup)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if primary.count() != 1 {
		t.Errorf("primary delivered %d, want 1 after a retry", primary.count())
	}
	if backup.count() != 0 {
		t.Error("failed over despite the retry succeeding")
	}
}

// Airgap mode must refuse any channel that admits to leaving the box, and still
// deliver over the ones that do not (HLD §11).
func TestAirgapBlocksEgressChannels(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "cloud", 1)
	f.channel(t, "local", 2)

	cloud := &recorder{typ: "cloud", egress: true}
	local := &recorder{typ: "local"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1, Airgap: true}, cloud, local)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if cloud.count() != 0 {
		t.Error("an egress channel was used in airgap mode")
	}
	if local.count() != 1 {
		t.Errorf("local channel delivered %d, want 1", local.count())
	}

	// Turning airgap off at runtime takes effect immediately.
	w.SetAirgap(false)
	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if cloud.count() != 1 {
		t.Error("egress channel still blocked after SetAirgap(false)")
	}
}

// A note pinned to one channel type must not be delivered over another.
func TestNotePinnedChannel(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	if _, err := f.store.CreateNote(context.Background(), domain.Note{
		UserID: "u1", Text: "urgent", PlaceID: f.place.ID,
		Trigger: domain.TriggerPassby, Channel: "sms",
	}); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	f.channel(t, "email", 1)
	f.channel(t, "sms", 2)

	email := &recorder{typ: "email"}
	sms := &recorder{typ: "sms"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, email, sms)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if email.count() != 0 {
		t.Error("pinned note delivered over the wrong channel")
	}
	if sms.count() != 1 {
		t.Errorf("pinned channel delivered %d, want 1", sms.count())
	}
}

// An event with no matching notes is still recorded — the place's trigger history
// is an audit trail, not a delivery log — but nothing is pushed.
func TestEventWithoutNotesIsRecordedNotPushed(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.channel(t, "push", 1)

	push := &recorder{typ: "push"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push)

	if err := w.Handle(context.Background(), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if push.count() != 0 {
		t.Error("pushed a reminder with no notes attached")
	}
	events, err := f.store.ListTriggerEvents(context.Background(), "u1", 10)
	if err != nil {
		t.Fatalf("ListTriggerEvents: %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("recorded %d trigger events, want 1", len(events))
	}
}

// Consuming from the bus must produce the same result as calling Handle directly:
// the subscription is wiring, not logic.
func TestWorkerConsumesFromBus(t *testing.T) {
	f := newFixture(t, domain.User{ID: "u1", TZ: "UTC"})
	f.note(t, "oat milk", domain.TriggerPassby, false)
	f.channel(t, "push", 1)

	push := &recorder{typ: "push"}
	w := notify.NewWorker(f.store, f.bus, nil, notify.Config{Tries: 1}, push)
	if err := w.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer w.Stop()

	if err := bus.PublishDurableJSON(f.bus, bus.GeoSubject("u1"), geoEvent(domain.TriggerPassby, f.place.ID)); err != nil {
		t.Fatalf("publish: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for push.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if push.count() != 1 {
		t.Fatalf("worker delivered %d messages from the bus, want 1", push.count())
	}
}
