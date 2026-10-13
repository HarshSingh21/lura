package notify_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/notify"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Reminders that wait for an acknowledgement: every delivered reminder is a
// stored record per recipient, written before it is published, and only the
// recipient can clear it.

func pendingFor(t *testing.T, f *peerFixture, user string) []domain.ReminderRecord {
	t.Helper()
	rs, err := f.store.ListReminders(context.Background(), user, store.ReminderFilter{Status: domain.ReminderPending})
	if err != nil {
		t.Fatalf("ListReminders: %v", err)
	}
	return rs
}

// orderCheck is an in-app notifier that looks the record up in the store at
// the moment it is asked to publish — proving the write happened first.
type orderCheck struct {
	st     store.Store
	seen   []notify.Message
	stored []bool
}

func (o *orderCheck) Type() string { return "inapp" }
func (o *orderCheck) Egress() bool { return false }
func (o *orderCheck) Send(ctx context.Context, m notify.Message) error {
	_, err := o.st.GetReminder(ctx, m.UserID, m.ID)
	o.seen = append(o.seen, m)
	o.stored = append(o.stored, m.ID != "" && err == nil)
	return nil
}

func TestEveryRecipientGetsAStoredRecordBeforePublish(t *testing.T) {
	f := newPeerFixture(t, true)
	check := &orderCheck{st: f.store}
	f.w = notify.NewWorker(f.store, nil, nil, notify.Config{Tries: 1}, check)
	n := f.note(t, "buy milk", domain.TriggerPassby, nishtha, harsh, nishtha)

	f.handle(t, nishtha, domain.TriggerPassby)

	if len(check.seen) != 2 {
		t.Fatalf("published %d messages, want 2", len(check.seen))
	}
	for i, m := range check.seen {
		if !check.stored[i] {
			t.Errorf("message to %s published before its record was stored (id %q)", m.UserID, m.ID)
		}
		if m.Status != domain.ReminderPending || m.OwnerID != harsh || m.EventID != "geo_1" || m.CreatedAt == nil {
			t.Errorf("frame for %s lacks the record: %+v", m.UserID, m)
		}
		if m.SubjectUserID != nishtha || m.SubjectName != "Nishtha" {
			t.Errorf("frame subject = %q/%q", m.SubjectUserID, m.SubjectName)
		}
	}

	for _, who := range []string{harsh, nishtha} {
		rs := pendingFor(t, f, who)
		if len(rs) != 1 {
			t.Fatalf("%s has %d pending reminders, want 1", who, len(rs))
		}
		r := rs[0]
		if r.UserID != who || r.OwnerID != harsh || len(r.NoteIDs) != 1 || r.NoteIDs[0] != n.ID ||
			r.Body != "buy milk" || r.Kind != notify.KindNote || r.PlaceName != "Grocery" {
			t.Errorf("%s's record = %+v", who, r)
		}
	}
	if r := pendingFor(t, f, nishtha)[0]; r.FromUserID != harsh || r.FromName != "Harsh" {
		t.Errorf("Nishtha's record from = %q/%q", r.FromUserID, r.FromName)
	}

	// The trigger history now says whose device crossed.
	events, _ := f.store.ListTriggerEvents(context.Background(), harsh, 10)
	if len(events) != 1 || events[0].SubjectUserID != nishtha || events[0].SubjectName != "Nishtha" {
		t.Errorf("trigger event subject = %+v", events)
	}
	// ...and which crossing it was, by the id its reminders carry.
	if len(events) == 1 && events[0].GeoEventID != check.seen[0].EventID {
		t.Errorf("trigger event crossing id = %q, reminders' eventId = %q", events[0].GeoEventID, check.seen[0].EventID)
	}

	// A redelivered event does not duplicate anyone's record.
	f.handle(t, nishtha, domain.TriggerPassby)
	if len(pendingFor(t, f, harsh)) != 1 || len(pendingFor(t, f, nishtha)) != 1 {
		t.Error("redelivery stored a second reminder")
	}
}

func TestWatchReminderIsARecord(t *testing.T) {
	f := newPeerFixture(t, true)
	p, _ := f.store.GetPlace(context.Background(), harsh, grocery)
	p.WatchUserIDs = []string{nishtha}
	if _, err := f.store.UpdatePlace(context.Background(), p); err != nil {
		t.Fatalf("UpdatePlace: %v", err)
	}
	f.handle(t, nishtha, domain.TriggerArrive)

	rs := pendingFor(t, f, harsh)
	if len(rs) != 1 || rs[0].Kind != notify.KindWatch || rs[0].Title != "Nishtha arrived at Grocery" {
		t.Fatalf("watch records = %+v", rs)
	}
	if got := pendingFor(t, f, nishtha); len(got) != 0 {
		t.Errorf("the watched person got %d records", len(got))
	}
}

// The owner's own crossing with no note is a live toast, not a reminder.
func TestOwnCrossingWithoutNotesStoresNothing(t *testing.T) {
	f := newPeerFixture(t, true)
	f.handle(t, harsh, domain.TriggerArrive)
	if rs := pendingFor(t, f, harsh); len(rs) != 0 {
		t.Errorf("records = %+v, want none", rs)
	}
	if m := f.inapp.last(); m.ID != "" || m.Status != "" {
		t.Errorf("toast carries a record id %q / status %q", m.ID, m.Status)
	}
}

func TestOwnerAckMarksNoteDone(t *testing.T) {
	f := newPeerFixture(t, true)
	b := bus.NewInProcess(nil)
	t.Cleanup(func() { _ = b.Close() })
	f.w = notify.NewWorker(f.store, b, nil, notify.Config{Tries: 1}, f.inapp)
	frames := make(chan bus.Msg, 4)
	if _, err := b.Subscribe(bus.ReminderAckSubject(harsh), func(m bus.Msg) { frames <- m }); err != nil {
		t.Fatal(err)
	}
	n := f.note(t, "buy milk", domain.TriggerPassby, "", harsh, nishtha)
	f.handle(t, harsh, domain.TriggerPassby)
	mine := pendingFor(t, f, harsh)[0]
	before := len(f.inapp.all())

	res, err := f.w.Acknowledge(context.Background(), harsh, mine.ID)
	if err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}
	if res.Reminder.Status != domain.ReminderAcknowledged || res.Reminder.AckedAt == nil {
		t.Errorf("reminder = %+v", res.Reminder)
	}
	// The owner acknowledging finishes the note, even though Nishtha has not.
	if len(res.NotesDone) != 1 || res.NotesDone[0] != n.ID {
		t.Errorf("notesDone = %v", res.NotesDone)
	}
	if got, _ := f.store.GetNote(context.Background(), harsh, n.ID); !got.Done {
		t.Error("note not done after the owner acknowledged")
	}
	// No ack notice to yourself.
	if len(f.inapp.all()) != before {
		t.Errorf("owner acking their own reminder sent %d notices", len(f.inapp.all())-before)
	}

	select {
	case m := <-frames:
		var frame notify.AckFrame
		if err := json.Unmarshal(m.Data, &frame); err != nil || frame.ID != mine.ID || frame.AckedAt.IsZero() {
			t.Errorf("reminder_ack frame = %s (%v)", m.Data, err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no reminder_ack frame published")
	}
}

func TestPeerAckNotifiesOwnerAndNoteDoneWhenEveryoneAcked(t *testing.T) {
	f := newPeerFixture(t, true)
	n := f.note(t, "buy milk", domain.TriggerPassby, nishtha, harsh, nishtha)
	f.handle(t, nishtha, domain.TriggerPassby)
	hers := pendingFor(t, f, nishtha)[0]
	his := pendingFor(t, f, harsh)[0]
	ctx := context.Background()

	// The owner cannot acknowledge on her behalf; a stranger even less.
	if _, err := f.w.Acknowledge(ctx, harsh, hers.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("owner acking recipient's reminder: err = %v, want ErrNotFound", err)
	}
	if _, err := f.w.Acknowledge(ctx, "u_stranger", hers.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("stranger: err = %v, want ErrNotFound", err)
	}

	before := len(f.inapp.all())
	res, err := f.w.Acknowledge(ctx, nishtha, hers.ID)
	if err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}
	if len(res.NotesDone) != 0 {
		t.Errorf("note done while Harsh still has it pending: %v", res.NotesDone)
	}

	notices := f.inapp.all()[before:]
	if len(notices) != 1 {
		t.Fatalf("owner got %d ack notices, want 1", len(notices))
	}
	notice := notices[0]
	if notice.UserID != harsh || notice.Kind != notify.KindAck || notice.Title != "Nishtha acknowledged buy milk" ||
		notice.Status != domain.ReminderAcknowledged || notice.AckedBy != nishtha || notice.ID == "" {
		t.Errorf("ack notice = %+v", notice)
	}
	// Stored for the owner, already acknowledged: it informs, it does not nag.
	stored, err := f.store.GetReminder(ctx, harsh, notice.ID)
	if err != nil || stored.Kind != notify.KindAck || stored.Status != domain.ReminderAcknowledged {
		t.Errorf("stored notice = %+v (%v)", stored, err)
	}
	if got := pendingFor(t, f, harsh); len(got) != 1 || got[0].ID != his.ID {
		t.Errorf("Harsh's pending = %+v, want only his own reminder", got)
	}

	// Idempotent: a second ack sends no second notice and changes nothing.
	again, err := f.w.Acknowledge(ctx, nishtha, hers.ID)
	if err != nil || !again.Reminder.AckedAt.Equal(*res.Reminder.AckedAt) {
		t.Errorf("second ack = %+v, %v", again.Reminder, err)
	}
	if len(f.inapp.all()) != before+1 {
		t.Error("a repeated ack notified the owner again")
	}

	// Harsh acknowledges his too: now everyone has, and the note is done.
	if _, err := f.w.Acknowledge(ctx, harsh, his.ID); err != nil {
		t.Fatalf("Acknowledge(harsh): %v", err)
	}
	if got, _ := f.store.GetNote(ctx, harsh, n.ID); !got.Done {
		t.Error("note not done after every recipient acknowledged")
	}
}

func TestNoteDoneWhenTheOnlyRecipientIsAPeer(t *testing.T) {
	f := newPeerFixture(t, true)
	n := f.note(t, "pick up parcel", domain.TriggerPassby, nishtha, nishtha)
	f.handle(t, nishtha, domain.TriggerPassby)
	hers := pendingFor(t, f, nishtha)
	if len(hers) != 1 {
		t.Fatalf("Nishtha has %d pending, want 1", len(hers))
	}
	res, err := f.w.Acknowledge(context.Background(), nishtha, hers[0].ID)
	if err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}
	if len(res.NotesDone) != 1 {
		t.Errorf("notesDone = %v, want the note", res.NotesDone)
	}
	if got, _ := f.store.GetNote(context.Background(), harsh, n.ID); !got.Done {
		t.Error("note not done")
	}
}

// A removed connection ends what each learns of the other. Nishtha still holds
// the reminder Harsh's note sent her while they were connected — it is her own
// record — but acknowledging it after she removed him must not tell him, nor
// tick off his note: that would be news of her reaching him after removal.
func TestAckAfterRemovalStaysWithTheRecipient(t *testing.T) {
	f := newPeerFixture(t, true)
	// She is the note's only recipient, so hers is the last one pending:
	// before the fix her ack both notified him and marked his note done.
	n := f.note(t, "pick up parcel", domain.TriggerPassby, nishtha, nishtha)
	f.handle(t, nishtha, domain.TriggerPassby)
	hers := pendingFor(t, f, nishtha)
	if len(hers) != 1 {
		t.Fatalf("Nishtha has %d pending, want 1", len(hers))
	}
	ctx := context.Background()
	for _, pair := range [][2]string{{nishtha, harsh}, {harsh, nishtha}} {
		if err := f.store.DeleteConnection(ctx, pair[0], pair[1]); err != nil {
			t.Fatalf("DeleteConnection: %v", err)
		}
	}

	before := len(f.inapp.all())
	res, err := f.w.Acknowledge(ctx, nishtha, hers[0].ID)
	if err != nil {
		t.Fatalf("Acknowledge: %v", err)
	}
	if res.Reminder.Status != domain.ReminderAcknowledged {
		t.Errorf("her reminder = %+v, want acknowledged", res.Reminder)
	}
	if got := f.inapp.all()[before:]; len(got) != 0 {
		t.Errorf("Harsh was told after the removal: %+v", got)
	}
	acks, _ := f.store.ListReminders(ctx, harsh, store.ReminderFilter{})
	for _, r := range acks {
		if r.Kind == notify.KindAck {
			t.Errorf("an ack notice was stored for Harsh after the removal: %+v", r)
		}
	}
	if len(res.NotesDone) != 0 {
		t.Errorf("notesDone = %v, want none", res.NotesDone)
	}
	if got, _ := f.store.GetNote(ctx, harsh, n.ID); got.Done {
		t.Error("her ack after the removal marked Harsh's note done")
	}
}
