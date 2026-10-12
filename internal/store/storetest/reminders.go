package storetest

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/store"
)

// Reminders that wait for an acknowledgement, and the activity sources. Both
// stores must agree on the ack guard (recipient only, idempotent, first ack
// time kept), on event-id idempotency, and on window filtering.

func mustReminder(t *testing.T, st store.Store, r domain.ReminderRecord) domain.ReminderRecord {
	t.Helper()
	saved, err := st.SaveReminder(ctxFor(t), r)
	if err != nil {
		t.Fatalf("SaveReminder: %v", err)
	}
	return saved
}

func testReminders(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "owner")
	mustUser(t, st, "peer")
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)

	first := mustReminder(t, st, domain.ReminderRecord{
		UserID: "owner", OwnerID: "owner", NoteIDs: []string{"n1"},
		PlaceID: "p1", PlaceName: "Grocery", Trigger: domain.TriggerPassby,
		Kind: domain.ReminderKindNote, Title: "Passing Grocery", Body: "buy milk",
		SubjectUserID: "owner", SubjectName: "Owner", EventID: "geo_1", CreatedAt: base,
	})
	if first.ID == "" || first.Status != domain.ReminderPending {
		t.Fatalf("saved = %+v, want an id and status pending", first)
	}
	if !first.CreatedAt.Equal(base) {
		t.Errorf("createdAt = %v, want %v", first.CreatedAt, base)
	}

	// Redelivery of the same event for the same recipient is a no-op.
	again := mustReminder(t, st, domain.ReminderRecord{
		UserID: "owner", OwnerID: "owner", EventID: "geo_1", Title: "dup", CreatedAt: base.Add(time.Second),
	})
	if again.ID != first.ID || again.Title != first.Title {
		t.Errorf("redelivered event stored a second reminder: %+v", again)
	}

	// The same event for another recipient is its own record.
	peers := mustReminder(t, st, domain.ReminderRecord{
		UserID: "peer", OwnerID: "owner", NoteIDs: []string{"n1"}, Kind: domain.ReminderKindNote,
		FromUserID: "owner", FromName: "Owner", EventID: "geo_1", CreatedAt: base,
	})
	if peers.ID == first.ID {
		t.Fatal("two recipients share one record")
	}
	if peers.FromUserID != "owner" || peers.FromName != "Owner" {
		t.Errorf("from fields lost: %+v", peers)
	}

	second := mustReminder(t, st, domain.ReminderRecord{
		UserID: "owner", OwnerID: "owner", Kind: domain.ReminderKindWatch,
		EventID: "geo_2", CreatedAt: base.Add(10 * time.Minute),
	})
	if len(second.NoteIDs) != 0 || second.NoteIDs == nil {
		t.Errorf("noteIds = %#v, want empty non-nil", second.NoteIDs)
	}

	got, err := st.GetReminder(ctx, "owner", first.ID)
	if err != nil {
		t.Fatalf("GetReminder: %v", err)
	}
	if got.Body != "buy milk" || got.PlaceName != "Grocery" || got.Trigger != domain.TriggerPassby ||
		got.SubjectName != "Owner" || len(got.NoteIDs) != 1 {
		t.Errorf("round trip = %+v", got)
	}
	if _, err := st.GetReminder(ctx, "peer", first.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("another user's reminder: err = %v, want ErrNotFound", err)
	}

	pending, err := st.ListReminders(ctx, "owner", store.ReminderFilter{Status: domain.ReminderPending})
	if err != nil {
		t.Fatalf("ListReminders: %v", err)
	}
	if len(pending) != 2 || pending[0].ID != second.ID || pending[1].ID != first.ID {
		t.Fatalf("pending = %v, want [second, first] newest first", reminderIDs(pending))
	}
	limited, _ := st.ListReminders(ctx, "owner", store.ReminderFilter{Limit: 1})
	if len(limited) != 1 || limited[0].ID != second.ID {
		t.Errorf("limit 1 = %v", reminderIDs(limited))
	}

	n, err := st.PendingRemindersForNote(ctx, "owner", "n1")
	if err != nil {
		t.Fatalf("PendingRemindersForNote: %v", err)
	}
	if n != 2 {
		t.Errorf("pending for n1 = %d, want 2 (owner's and peer's)", n)
	}

	// Window: created inside, or acknowledged inside.
	inWindow, _ := st.ListReminders(ctx, "owner", store.ReminderFilter{
		From: base.Add(5 * time.Minute), To: base.Add(15 * time.Minute),
	})
	if len(inWindow) != 1 || inWindow[0].ID != second.ID {
		t.Errorf("window = %v, want [second]", reminderIDs(inWindow))
	}
	ackAt := base.Add(12 * time.Minute)
	if _, _, err := st.AckReminder(ctx, "owner", first.ID, ackAt); err != nil {
		t.Fatalf("AckReminder: %v", err)
	}
	inWindow, _ = st.ListReminders(ctx, "owner", store.ReminderFilter{
		From: base.Add(5 * time.Minute), To: base.Add(15 * time.Minute),
	})
	if len(inWindow) != 2 {
		t.Errorf("window after ack = %v, want both (one created, one acked inside)", reminderIDs(inWindow))
	}
}

func testReminderAck(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "owner")
	mustUser(t, st, "peer")
	r := mustReminder(t, st, domain.ReminderRecord{
		UserID: "peer", OwnerID: "owner", NoteIDs: []string{"n1"}, Kind: domain.ReminderKindNote, EventID: "e1",
	})

	// Not the recipient: the owner cannot acknowledge on the peer's behalf.
	if _, _, err := st.AckReminder(ctx, "owner", r.ID, time.Now()); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("owner acking peer's reminder: err = %v, want ErrNotFound", err)
	}
	if _, _, err := st.AckReminder(ctx, "peer", "rem_missing", time.Now()); !errors.Is(err, domain.ErrNotFound) {
		t.Errorf("missing reminder: err = %v, want ErrNotFound", err)
	}

	at := time.Now().UTC().Truncate(time.Second)
	acked, changed, err := st.AckReminder(ctx, "peer", r.ID, at)
	if err != nil || !changed {
		t.Fatalf("AckReminder = changed %v, err %v", changed, err)
	}
	if acked.Status != domain.ReminderAcknowledged || acked.AckedAt == nil || !acked.AckedAt.Equal(at) || acked.AckedBy != "peer" {
		t.Errorf("acked = %+v", acked)
	}

	// Idempotent: a second ack changes nothing and keeps the first time.
	again, changed, err := st.AckReminder(ctx, "peer", r.ID, at.Add(time.Minute))
	if err != nil || changed {
		t.Fatalf("second AckReminder = changed %v, err %v", changed, err)
	}
	if again.AckedAt == nil || !again.AckedAt.Equal(at) {
		t.Errorf("second ack moved ackedAt to %v", again.AckedAt)
	}

	n, _ := st.PendingRemindersForNote(ctx, "owner", "n1")
	if n != 0 {
		t.Errorf("pending for n1 after ack = %d, want 0", n)
	}
	pending, _ := st.ListReminders(ctx, "peer", store.ReminderFilter{Status: domain.ReminderPending})
	acknowledged, _ := st.ListReminders(ctx, "peer", store.ReminderFilter{Status: domain.ReminderAcknowledged})
	if len(pending) != 0 || len(acknowledged) != 1 {
		t.Errorf("pending %d, acknowledged %d; want 0, 1", len(pending), len(acknowledged))
	}

	// A record can be stored already acknowledged (the owner's kind:"ack" notice).
	notice := mustReminder(t, st, domain.ReminderRecord{
		UserID: "owner", OwnerID: "owner", Kind: domain.ReminderKindAck,
		Status: domain.ReminderAcknowledged, AckedAt: &at, AckedBy: "peer",
	})
	if notice.Status != domain.ReminderAcknowledged || notice.AckedBy != "peer" || notice.AckedAt == nil {
		t.Errorf("ack notice = %+v", notice)
	}
}

func testTriggerEventsBetween(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "u1")
	mustUser(t, st, "u2")
	mustPlace(t, st, "u1", "p1", "Home", 12.9611, 77.6387, 120)
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	for i := 0; i < 4; i++ {
		if _, err := st.InsertTriggerEvent(ctx, domain.TriggerEvent{
			UserID: "u1", PlaceID: "p1", PlaceName: "Home", DeviceID: "d1",
			Trigger: domain.TriggerArrive, TS: base.Add(time.Duration(i) * 10 * time.Minute),
			NoteIDs: []string{}, Delivered: []string{},
			SubjectUserID: "u2", SubjectName: "Peer", GeoEventID: fmt.Sprintf("geo_%d", i),
		}); err != nil {
			t.Fatalf("InsertTriggerEvent: %v", err)
		}
	}
	got, err := st.TriggerEventsBetween(ctx, "u1", store.RangeQuery{From: base.Add(5 * time.Minute), To: base.Add(25 * time.Minute)})
	if err != nil {
		t.Fatalf("TriggerEventsBetween: %v", err)
	}
	if len(got) != 2 || !got[0].TS.After(got[1].TS) {
		t.Fatalf("window = %d events, want 2 newest first", len(got))
	}
	if got[0].SubjectUserID != "u2" || got[0].SubjectName != "Peer" {
		t.Errorf("subject lost: %+v", got[0])
	}
	if got[0].GeoEventID != "geo_2" || got[1].GeoEventID != "geo_1" {
		t.Errorf("crossing ids = %q, %q, want geo_2, geo_1", got[0].GeoEventID, got[1].GeoEventID)
	}
	limited, _ := st.TriggerEventsBetween(ctx, "u1", store.RangeQuery{Limit: 3})
	if len(limited) != 3 {
		t.Errorf("limit 3 = %d", len(limited))
	}
	other, _ := st.TriggerEventsBetween(ctx, "u2", store.RangeQuery{})
	if len(other) != 0 {
		t.Errorf("u2 sees %d of u1's events", len(other))
	}
}

func testConnectionEvents(t *testing.T, st store.Store) {
	ctx := ctxFor(t)
	mustUser(t, st, "a")
	mustUser(t, st, "b")
	base := time.Now().UTC().Add(-time.Hour).Truncate(time.Second)
	actions := []domain.ConnectionAction{
		domain.ConnectionActionInvited, domain.ConnectionActionAccepted,
		domain.ConnectionActionPaused, domain.ConnectionActionResumed,
	}
	for i, a := range actions {
		if _, err := st.InsertConnectionEvent(ctx, domain.ConnectionEvent{
			UserID: "a", PeerID: "b", PeerName: "B", Action: a, ActorID: "a",
			TS: base.Add(time.Duration(i) * time.Minute),
		}); err != nil {
			t.Fatalf("InsertConnectionEvent: %v", err)
		}
	}
	if _, err := st.InsertConnectionEvent(ctx, domain.ConnectionEvent{UserID: "a"}); !errors.Is(err, domain.ErrInvalid) {
		t.Errorf("incomplete event: err = %v, want ErrInvalid", err)
	}

	all, err := st.ListConnectionEvents(ctx, "a", store.RangeQuery{})
	if err != nil {
		t.Fatalf("ListConnectionEvents: %v", err)
	}
	if len(all) != 4 || all[0].Action != domain.ConnectionActionResumed || all[3].Action != domain.ConnectionActionInvited {
		t.Fatalf("events = %+v, want 4 newest first", all)
	}
	if all[0].PeerName != "B" || all[0].ActorID != "a" || all[0].ID == "" {
		t.Errorf("round trip = %+v", all[0])
	}
	window, _ := st.ListConnectionEvents(ctx, "a", store.RangeQuery{From: base.Add(30 * time.Second), To: base.Add(150 * time.Second)})
	if len(window) != 2 {
		t.Errorf("window = %d, want 2", len(window))
	}
	if other, _ := st.ListConnectionEvents(ctx, "b", store.RangeQuery{}); len(other) != 0 {
		t.Errorf("b sees %d of a's events", len(other))
	}
}

func reminderIDs(rs []domain.ReminderRecord) []string {
	out := make([]string, 0, len(rs))
	for _, r := range rs {
		out = append(out, r.ID)
	}
	return out
}
