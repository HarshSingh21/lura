package notify_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/store/memory"
)

// These tests cover reminders that cross between people: a note Harsh wrote
// that fires on Nishtha's movement and notifies both of them, and the "watch"
// reminder Harsh gets when Nishtha crosses a fence he watches her on.

const (
	harsh   = "u_harsh"
	nishtha = "u_nishtha"
	grocery = "p_grocery"
)

type peerFixture struct {
	store *memory.Store
	inapp *recorder
	ntfy  *recorder
	hook  *recorder
	w     *notify.Worker
}

// newPeerFixture: Harsh and Nishtha are connected; Harsh owns "Grocery".
// Harsh pushes via webhook, Nishtha via ntfy, so each recipient's own channels
// are distinguishable.
func newPeerFixture(t *testing.T, connected bool) *peerFixture {
	t.Helper()
	ctx := context.Background()
	st := memory.New()
	for _, u := range []domain.User{
		{ID: harsh, DisplayName: "Harsh", TZ: "UTC"},
		{ID: nishtha, DisplayName: "Nishtha", TZ: "UTC"},
	} {
		if err := st.UpsertUser(ctx, u); err != nil {
			t.Fatalf("UpsertUser: %v", err)
		}
	}
	if connected {
		for _, c := range []domain.Connection{
			{UserID: harsh, PeerID: nishtha, Status: domain.ConnectionAccepted, Sharing: true},
			{UserID: nishtha, PeerID: harsh, Status: domain.ConnectionAccepted, Sharing: true},
		} {
			if _, err := st.UpsertConnection(ctx, c); err != nil {
				t.Fatalf("UpsertConnection: %v", err)
			}
		}
	}
	if _, err := st.CreatePlace(ctx, domain.Place{
		ID: grocery, UserID: harsh, Name: "Grocery",
		Center: domain.Point{Lat: 12.9611, Lon: 77.6387}, RadiusM: 80,
		Triggers: []domain.Trigger{domain.TriggerArrive, domain.TriggerLeave, domain.TriggerPassby},
	}); err != nil {
		t.Fatalf("CreatePlace: %v", err)
	}
	for _, c := range []domain.Channel{
		{UserID: harsh, Type: "webhook", Enabled: true, Priority: 1},
		{UserID: nishtha, Type: "ntfy", Enabled: true, Priority: 1},
	} {
		if _, err := st.CreateChannel(ctx, c); err != nil {
			t.Fatalf("CreateChannel: %v", err)
		}
	}
	f := &peerFixture{
		store: st,
		inapp: &recorder{typ: "inapp"},
		ntfy:  &recorder{typ: "ntfy"},
		hook:  &recorder{typ: "webhook"},
	}
	f.w = notify.NewWorker(st, nil, nil, notify.Config{Tries: 1, RetryDelay: time.Millisecond}, f.inapp, f.ntfy, f.hook)
	return f
}

func (f *peerFixture) note(t *testing.T, text string, trigger domain.Trigger, watch string, notify ...string) domain.Note {
	t.Helper()
	n, err := f.store.CreateNote(context.Background(), domain.Note{
		UserID: harsh, Text: text, PlaceID: grocery, Trigger: trigger,
		WatchUserID: watch, NotifyUserIDs: notify,
	})
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}
	return n
}

func (f *peerFixture) handle(t *testing.T, subject string, trigger domain.Trigger) {
	t.Helper()
	name := "Harsh"
	if subject == nishtha {
		name = "Nishtha"
	}
	if err := f.w.Handle(context.Background(), domain.GeoEvent{
		ID: "geo_1", UserID: harsh, DeviceID: subject + "_phone", PlaceID: grocery,
		PlaceName: "Grocery", Trigger: trigger, TS: time.Now().UTC(),
		SubjectUserID: subject, SubjectName: name,
	}); err != nil {
		t.Fatalf("Handle: %v", err)
	}
}

func (r *recorder) all() []notify.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]notify.Message(nil), r.messages...)
}

func byRecipient(msgs []notify.Message) map[string]notify.Message {
	out := map[string]notify.Message{}
	for _, m := range msgs {
		out[m.UserID] = m
	}
	return out
}

// The reference scenario: "buy milk" fires when Nishtha passes and reaches
// both of them, each on their own subject and their own push channel.
func TestPeerNoteDeliveredToBothRecipients(t *testing.T) {
	f := newPeerFixture(t, true)
	n := f.note(t, "buy milk", domain.TriggerPassby, nishtha, harsh, nishtha)

	f.handle(t, nishtha, domain.TriggerPassby)

	got := byRecipient(f.inapp.all())
	if len(got) != 2 {
		t.Fatalf("in-app messages = %+v, want one each for Harsh and Nishtha", f.inapp.all())
	}
	toHarsh, toNishtha := got[harsh], got[nishtha]

	if toHarsh.Title != "Nishtha passed by Grocery" || toHarsh.Body != "buy milk" || toHarsh.Kind != notify.KindNote {
		t.Errorf("Harsh's reminder = %q / %q / %q", toHarsh.Title, toHarsh.Body, toHarsh.Kind)
	}
	if toHarsh.FromUserID != "" || toHarsh.FromName != "" {
		t.Errorf("Harsh's own note carries from=%q/%q", toHarsh.FromUserID, toHarsh.FromName)
	}
	if toNishtha.Title != "Passing Grocery" || toNishtha.Body != "buy milk" {
		t.Errorf("Nishtha's reminder = %q / %q, want her own point of view", toNishtha.Title, toNishtha.Body)
	}
	if toNishtha.FromUserID != harsh || toNishtha.FromName != "Harsh" {
		t.Errorf("Nishtha's reminder from = %q/%q, want Harsh", toNishtha.FromUserID, toNishtha.FromName)
	}
	if len(toNishtha.NoteIDs) != 1 || toNishtha.NoteIDs[0] != n.ID {
		t.Errorf("Nishtha's reminder notes = %v", toNishtha.NoteIDs)
	}

	// Each through their own channels.
	if f.hook.count() != 1 || f.hook.last().UserID != harsh {
		t.Errorf("webhook (Harsh's) got %d messages, last for %q", f.hook.count(), f.hook.last().UserID)
	}
	if f.ntfy.count() != 1 || f.ntfy.last().UserID != nishtha {
		t.Errorf("ntfy (Nishtha's) got %d messages, last for %q", f.ntfy.count(), f.ntfy.last().UserID)
	}

	fired, err := f.store.GetNote(context.Background(), harsh, n.ID)
	if err != nil || fired.FiredAt == nil {
		t.Errorf("note not marked fired: %+v %v", fired, err)
	}
	events, _ := f.store.ListTriggerEvents(context.Background(), harsh, 10)
	if len(events) != 1 || len(events[0].Delivered) < 3 {
		t.Errorf("trigger history = %+v, want one event delivered on inapp+webhook+ntfy", events)
	}
	if theirs, _ := f.store.ListTriggerEvents(context.Background(), nishtha, 10); len(theirs) != 0 {
		t.Errorf("Nishtha has Harsh's trigger history: %+v", theirs)
	}
}

// Quiet hours belong to the recipient: Nishtha asleep suppresses her push only.
func TestPeerRecipientQuietHoursAreTheirs(t *testing.T) {
	f := newPeerFixture(t, true)
	if _, err := f.store.UpdateUserSettings(context.Background(), nishtha, func(u *domain.User) {
		u.QuietFrom, u.QuietTo = "00:00", "23:59"
	}); err != nil {
		t.Fatalf("UpdateUserSettings: %v", err)
	}
	f.note(t, "buy milk", domain.TriggerPassby, nishtha, harsh, nishtha)

	f.handle(t, nishtha, domain.TriggerPassby)

	if f.ntfy.count() != 0 {
		t.Error("Nishtha's push was sent during her quiet hours")
	}
	if f.hook.count() != 1 {
		t.Error("Harsh's push was suppressed by Nishtha's quiet hours")
	}
	if got := byRecipient(f.inapp.all()); len(got) != 2 {
		t.Errorf("in-app = %+v, want both (quiet hours never suppress in-app)", got)
	}
}

// A watched crossing with no note is a kind:"watch" reminder for the owner —
// and nothing at all for the person watched.
func TestWatchReminderForOwner(t *testing.T) {
	cases := []struct {
		trigger domain.Trigger
		title   string
	}{
		{domain.TriggerArrive, "Nishtha arrived at Grocery"},
		{domain.TriggerLeave, "Nishtha left Grocery"},
		{domain.TriggerPassby, "Nishtha passed by Grocery"},
		{domain.TriggerDwell, "Nishtha is staying at Grocery"},
	}
	for _, tc := range cases {
		t.Run(string(tc.trigger), func(t *testing.T) {
			f := newPeerFixture(t, true)
			ctx := context.Background()
			p, _ := f.store.GetPlace(ctx, harsh, grocery)
			p.WatchUserIDs = []string{nishtha}
			if _, err := f.store.UpdatePlace(ctx, p); err != nil {
				t.Fatalf("UpdatePlace: %v", err)
			}

			f.handle(t, nishtha, tc.trigger)

			msgs := f.inapp.all()
			if len(msgs) != 1 || msgs[0].UserID != harsh {
				t.Fatalf("in-app = %+v, want one message for Harsh only", msgs)
			}
			m := msgs[0]
			if m.Kind != notify.KindWatch || m.Title != tc.title || len(m.NoteIDs) != 0 {
				t.Errorf("watch reminder = kind %q title %q notes %v", m.Kind, m.Title, m.NoteIDs)
			}
			if m.Event.SubjectUserID != nishtha || m.Event.SubjectName != "Nishtha" {
				t.Errorf("event subject = %q/%q", m.Event.SubjectUserID, m.Event.SubjectName)
			}
			if f.hook.count() != 1 {
				t.Error("a watch reminder is not pushed to the owner's channel")
			}
			if f.ntfy.count() != 0 {
				t.Error("the watched person was told about the owner's watch")
			}
		})
	}
}

// A watched place plus a note to the owner is still one ping, not two.
func TestWatchAndNoteIsOnePing(t *testing.T) {
	f := newPeerFixture(t, true)
	ctx := context.Background()
	p, _ := f.store.GetPlace(ctx, harsh, grocery)
	p.WatchUserIDs = []string{nishtha}
	if _, err := f.store.UpdatePlace(ctx, p); err != nil {
		t.Fatalf("UpdatePlace: %v", err)
	}
	f.note(t, "ask her to grab bread", domain.TriggerArrive, nishtha)

	f.handle(t, nishtha, domain.TriggerArrive)

	msgs := f.inapp.all()
	if len(msgs) != 1 || msgs[0].Kind != notify.KindNote || msgs[0].Body != "ask her to grab bread" {
		t.Fatalf("in-app = %+v, want the single note reminder", msgs)
	}
}

// Whose movement fires a note is respected in both directions.
func TestNotesFireOnlyForTheirSubject(t *testing.T) {
	f := newPeerFixture(t, true)
	f.note(t, "buy milk (Nishtha)", domain.TriggerArrive, nishtha)
	f.note(t, "buy eggs (me)", domain.TriggerArrive, "")

	f.handle(t, harsh, domain.TriggerArrive)
	if m := f.inapp.last(); m.Body != "buy eggs (me)" {
		t.Errorf("Harsh's own arrival delivered %q", m.Body)
	}

	f.handle(t, nishtha, domain.TriggerArrive)
	if m := f.inapp.last(); m.Body != "buy milk (Nishtha)" || m.Title != "Nishtha arrived at Grocery" {
		t.Errorf("Nishtha's arrival delivered %q / %q", m.Title, m.Body)
	}
}

// Harsh's own note can notify Nishtha about Harsh: the title names him.
func TestOwnersNoteNotifyingPeerNamesTheOwner(t *testing.T) {
	f := newPeerFixture(t, true)
	f.note(t, "home soon", domain.TriggerLeave, "", nishtha)

	f.handle(t, harsh, domain.TriggerLeave)

	got := byRecipient(f.inapp.all())
	toNishtha, ok := got[nishtha]
	if !ok {
		t.Fatalf("Nishtha did not get the reminder: %+v", f.inapp.all())
	}
	if toNishtha.Title != "Harsh left Grocery" || toNishtha.FromName != "Harsh" {
		t.Errorf("Nishtha's reminder = %q from %q", toNishtha.Title, toNishtha.FromName)
	}
	// Harsh still gets his live toast for his own crossing (in-app only: the
	// note is not addressed to him).
	if m, ok := got[harsh]; !ok || len(m.NoteIDs) != 0 {
		t.Errorf("Harsh's own crossing toast = %+v", m)
	}
	if f.hook.count() != 0 {
		t.Error("Harsh was pushed a note that does not notify him")
	}
}

// Removing the connection stops notes reaching the former peer, even notes
// written while they were connected.
func TestDisconnectedRecipientIsSkipped(t *testing.T) {
	f := newPeerFixture(t, false)
	f.note(t, "home soon", domain.TriggerLeave, "", harsh, nishtha)

	f.handle(t, harsh, domain.TriggerLeave)

	for _, m := range f.inapp.all() {
		if m.UserID == nishtha {
			t.Fatalf("a disconnected person received %+v", m)
		}
	}
	if f.ntfy.count() != 0 {
		t.Error("a disconnected person was pushed a reminder")
	}
}

// The wire names of the new fields match client/src/api/types.ts.
func TestReminderWireNames(t *testing.T) {
	f := newPeerFixture(t, true)
	f.note(t, "buy milk", domain.TriggerPassby, nishtha, nishtha)
	f.handle(t, nishtha, domain.TriggerPassby)
	raw, err := json.Marshal(f.inapp.last())
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["kind"] != "note" || wire["fromUserId"] != harsh || wire["fromName"] != "Harsh" {
		t.Errorf("reminder wire = %s", raw)
	}
	event, _ := wire["event"].(map[string]any)
	if event["subjectUserId"] != nishtha || event["subjectName"] != "Nishtha" {
		t.Errorf("reminder event wire = %v", event)
	}
}
