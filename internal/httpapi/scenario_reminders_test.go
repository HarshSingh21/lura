package httpapi_test

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/hub"
	"github.com/HarshSingh21/locnot/internal/notify"
)

// Reminder scenarios from docs/release-spec.md §2 and §6, played by Harsh and
// Nishtha over the real API and sockets, on every store backend.

// The commute: along the lon 77.6005 meridian, Home (south) → Grocery → Office
// (north). groceryRing (fences_test.go) spans 12.9000–12.9010.
var (
	remHome       = [2]float64{12.8900, 77.6005}
	remLeaveHome  = [2]float64{12.8950, 77.6005}
	remPastShop   = [2]float64{12.9060, 77.6005}
	remOffice     = [2]float64{12.9120, 77.6005}
	remInPharmacy = [2]float64{12.9035, 77.6005}
)

const remDriving = 12.0 // m/s, about 43 km/h

// pharmacyRing is a second shop on the same road, north of the grocery.
func pharmacyRing() []map[string]float64 {
	return []map[string]float64{
		{"lat": 12.9030, "lon": 77.6000},
		{"lat": 12.9030, "lon": 77.6010},
		{"lat": 12.9040, "lon": 77.6010},
		{"lat": 12.9040, "lon": 77.6000},
	}
}

func remCircle(name string, at [2]float64, triggers ...string) map[string]any {
	return map[string]any{
		"name": name, "center": map[string]float64{"lat": at[0], "lon": at[1]},
		"radiusM": 100, "triggers": triggers,
	}
}

// drive takes Harsh from Home to Office past the Grocery and returns every
// frame his socket saw up to his message for the arrival at the Office.
func (s *remStack) drive(t *testing.T, sock *remSock, officeID string) []hub.Frame {
	t.Helper()
	s.fix(t, s.harsh, remHome[0], remHome[1], 0.3)
	s.fix(t, s.harsh, remLeaveHome[0], remLeaveHome[1], remDriving)
	s.fix(t, s.harsh, inGrocery[0], inGrocery[1], remDriving)
	s.fix(t, s.harsh, remPastShop[0], remPastShop[1], remDriving)
	s.fix(t, s.harsh, remOffice[0], remOffice[1], 0.5)
	return sock.notifiedAt(officeID, domain.TriggerArrive)
}

func onlyPending(t *testing.T, who string, got []domain.ReminderRecord, wantID string) domain.ReminderRecord {
	t.Helper()
	if len(got) != 1 || got[0].ID != wantID || got[0].Status != domain.ReminderPending {
		t.Fatalf("%s pending = %+v, want exactly %s pending", who, got, wantID)
	}
	return got[0]
}

// TestCommuteReminderWaitsForAcknowledgement is the release's reference case
// (§6): Harsh drives Home → Office past the Grocery with an open note "buy
// milk". Exactly one reminder fires; it stays pending through a reconnect, a
// second session and a server restart, and one Acknowledge clears it in every
// session. Nishtha, connected and sharing, hears nothing of it.
func TestCommuteReminderWaitsForAcknowledgement(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		homeID := s.place(t, s.harsh, remCircle("Home", remHome, "arrive", "leave"))
		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive", "leave"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		note := s.note(t, s.harsh, map[string]any{"text": "buy milk", "placeId": groceryID, "trigger": "passby"})
		noteID := note["id"].(string)
		if ids := note["notifyUserIds"].([]any); len(ids) != 0 || note["watchUserId"] != "" {
			t.Fatalf("a plain note = %v, want watchUserId \"\" and notifyUserIds []", note)
		}

		tab := s.dial(t, s.harsh)
		hers := s.dial(t, s.nishtha)

		frames := remCollect(t, s.drive(t, tab, officeID))
		stored := frames.stored()
		if len(stored) != 1 {
			t.Fatalf("Harsh's socket carried %d acknowledgeable reminders, want exactly 1: %+v", len(stored), stored)
		}
		live := stored[0]
		if live.Status != domain.ReminderPending || live.Body != "buy milk" || live.Kind != notify.KindNote ||
			live.Trigger != domain.TriggerPassby || live.PlaceID != groceryID || live.Title != "Passed by Grocery" ||
			live.FromUserID != "" || len(live.NoteIDs) != 1 || live.NoteIDs[0] != noteID {
			t.Fatalf("the commute reminder = %+v", live)
		}
		// The other crossings of the drive are live toasts, never records.
		for _, m := range frames.reminders {
			if m.ID == "" && m.PlaceID == groceryID {
				t.Errorf("a second, unstored message for the grocery pass: %+v", m)
			}
			if m.PlaceID == homeID || m.PlaceID == officeID {
				if m.ID != "" || m.Status != "" {
					t.Errorf("a crossing without a note was stored as a reminder: %+v", m)
				}
			}
		}

		// Stored before it was published: the list has it the moment the frame lands.
		rec := onlyPending(t, "Harsh", s.list(t, s.harsh, "?status=pending"), live.ID)
		if rec.OwnerID != s.harsh.id || rec.UserID != s.harsh.id || rec.Body != "buy milk" || rec.PlaceName != "Grocery" ||
			rec.SubjectUserID != s.harsh.id || rec.EventID == "" || rec.AckedAt != nil {
			t.Errorf("stored record = %+v", rec)
		}

		// Nishtha is connected and sharing, and learns nothing of it.
		theirs := hers.quiet(400 * time.Millisecond)
		if len(theirs.reminders) != 0 || len(theirs.geo) != 0 || len(theirs.acks) != 0 {
			t.Errorf("Nishtha's socket carried Harsh's commute: %+v", theirs)
		}
		if got := s.list(t, s.nishtha, "?status=all"); len(got) != 0 {
			t.Errorf("Nishtha has reminders: %+v", got)
		}

		// Reload: the socket drops and comes back; the reminder is still there.
		tab.close()
		tab = s.dial(t, s.harsh)
		onlyPending(t, "Harsh after reconnect", s.list(t, s.harsh, "?status=pending"), live.ID)
		if s.noteDone(t, s.harsh, noteID) {
			t.Fatal("the note is done before anyone acknowledged")
		}

		// Another device (or signing out and in again): a different session.
		laptop := s.secondSession(s.harsh, "laptop")
		onlyPending(t, "Harsh's laptop", s.list(t, laptop, "?status=pending"), live.ID)

		// Restart the server over the same data.
		s.restart(t)
		before := rec
		after := onlyPending(t, "Harsh after restart", s.list(t, s.harsh, "?status=pending"), live.ID)
		if !after.CreatedAt.Equal(before.CreatedAt) || after.Body != before.Body || after.EventID != before.EventID ||
			strings.Join(after.NoteIDs, ",") != noteID {
			t.Errorf("record changed across the restart: before %+v after %+v", before, after)
		}
		onlyPending(t, "Harsh's laptop after restart", s.list(t, laptop, "?status=pending"), live.ID)
		if s.noteDone(t, s.harsh, noteID) {
			t.Fatal("the note is done after a restart")
		}

		// Both of Harsh's sessions reconnect to the new server; Nishtha too.
		tab = s.dial(t, s.harsh)
		lap := s.dial(t, laptop)
		hers = s.dial(t, s.nishtha)

		// Acknowledge from the phone: both sessions clear, the note is done.
		res := s.ack(t, s.harsh, live.ID)
		if res.Reminder.Status != domain.ReminderAcknowledged || res.Reminder.AckedAt == nil || res.Reminder.AckedBy != s.harsh.id {
			t.Errorf("ack result = %+v", res.Reminder)
		}
		if len(res.NotesDone) != 1 || res.NotesDone[0] != noteID {
			t.Errorf("notesDone = %v, want [%s]: the owner acknowledged", res.NotesDone, noteID)
		}
		for name, c := range map[string]*remSock{"phone": tab, "laptop": lap} {
			if f := c.ackFrame(); f.ID != live.ID || !f.AckedAt.Equal(*res.Reminder.AckedAt) {
				t.Errorf("%s reminder_ack = %+v, want %s at %v", name, f, live.ID, res.Reminder.AckedAt)
			}
		}
		for _, sess := range []remUser{s.harsh, laptop} {
			if got := s.list(t, sess, "?status=pending"); len(got) != 0 {
				t.Errorf("still pending after the ack: %+v", got)
			}
			if got := s.list(t, sess, "?status=acknowledged"); len(got) != 1 || got[0].ID != live.ID {
				t.Errorf("acknowledged = %+v", got)
			}
		}
		if !s.noteDone(t, s.harsh, noteID) {
			t.Error("note not done after its owner acknowledged")
		}
		// His own ack is not news to himself, and Nishtha hears nothing.
		for _, m := range tab.quiet(300 * time.Millisecond).reminders {
			if m.Kind == notify.KindAck {
				t.Errorf("Harsh was told about his own ack: %+v", m)
			}
		}
		if got := hers.quiet(300 * time.Millisecond); len(got.acks) != 0 || len(got.reminders) != 0 {
			t.Errorf("Nishtha's socket carried Harsh's ack: %+v", got)
		}

		// Driving the same road tomorrow: the note is done, nothing to remind.
		again := remCollect(t, s.drive(t, tab, officeID))
		if st := again.stored(); len(st) != 0 {
			t.Errorf("a done note reminded again: %+v", st)
		}
		if got := s.list(t, s.harsh, "?status=pending"); len(got) != 0 {
			t.Errorf("pending after the second drive: %+v", got)
		}
	})
}

// TestNoteToldOnlyToNishthaNeverReachesHarsh pins §2: a note whose
// notifyUserIds is only Nishtha reaches her — from Harsh, on her own subject —
// and never Harsh, whether it fires on his movement or on hers.
func TestNoteToldOnlyToNishthaNeverReachesHarsh(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		pharmacyID := s.place(t, s.harsh, map[string]any{
			"name": "Pharmacy", "polygon": pharmacyRing(), "triggers": []string{"arrive"},
		})
		// Fires on Harsh's own drive, tells only Nishtha.
		milk := s.note(t, s.harsh, map[string]any{
			"text": "buy milk", "placeId": groceryID, "trigger": "passby",
			"notifyUserIds": []string{s.nishtha.id},
		})
		// Fires on Nishtha's movement, tells only Nishtha.
		aspirin := s.note(t, s.harsh, map[string]any{
			"text": "pick up aspirin", "placeId": pharmacyID, "trigger": "arrive",
			"watchUserId": s.nishtha.id, "notifyUserIds": []string{s.nishtha.id},
		})

		his := s.dial(t, s.harsh)
		hers := s.dial(t, s.nishtha)

		// ---- his movement
		frames := remCollect(t, s.drive(t, his, officeID))
		for _, m := range frames.reminders {
			if m.ID != "" || strings.Contains(m.Body, "buy milk") || len(m.NoteIDs) != 0 {
				t.Errorf("Harsh received the note told only to Nishtha: %+v", m)
			}
		}
		got := hers.reminderWithoutGeo()
		if got.ID == "" || got.Status != domain.ReminderPending || got.UserID != s.nishtha.id || got.Body != "buy milk" ||
			got.FromUserID != s.harsh.id || got.FromName != "Harsh" || got.OwnerID != s.harsh.id ||
			got.Title != "Harsh passed by Grocery" || got.SubjectUserID != s.harsh.id {
			t.Fatalf("Nishtha's reminder = %+v", got)
		}
		milkRec := onlyPending(t, "Nishtha", s.list(t, s.nishtha, "?status=pending"), got.ID)
		if milkRec.FromName != "Harsh" || milkRec.FromUserID != s.harsh.id {
			t.Errorf("stored record lost its sender: %+v", milkRec)
		}
		if mine := s.list(t, s.harsh, "?status=all"); len(mine) != 0 {
			t.Errorf("Harsh has records for a note told only to Nishtha: %+v", mine)
		}
		// Not hers to see: Harsh's reminder list is scoped, and her
		// acknowledgement is hers alone.
		if code, _ := s.errCode(s.harsh, http.MethodPost, "/api/v1/reminders/"+got.ID+"/ack", nil); code != http.StatusNotFound {
			t.Errorf("Harsh acking Nishtha's reminder = %d, want 404", code)
		}

		// ---- her movement
		s.fix(t, s.nishtha, remPastShop[0], remPastShop[1], 1)
		s.fix(t, s.nishtha, remInPharmacy[0], remInPharmacy[1], 0.5)
		hersToo := hers.reminderWithoutGeo()
		if hersToo.Body != "pick up aspirin" || hersToo.FromName != "Harsh" || hersToo.Title != "Arrived at Pharmacy" ||
			hersToo.SubjectUserID != s.nishtha.id {
			t.Errorf("Nishtha's own-arrival reminder = %+v", hersToo)
		}
		// Harsh watches her only through the note's fence: he may see the
		// crossing as a geo event, but never the reminder.
		for _, m := range his.quiet(500 * time.Millisecond).reminders {
			t.Errorf("Harsh received a notify frame for a note told only to Nishtha: %+v", m)
		}
		if mine := s.list(t, s.harsh, "?status=all"); len(mine) != 0 {
			t.Errorf("Harsh has records: %+v", mine)
		}

		// She acknowledges both: each note is done (she was its only
		// recipient), and Harsh — the owner — is told, kind "ack".
		for _, c := range []struct {
			id, note, text string
		}{{got.ID, milk["id"].(string), "buy milk"}, {hersToo.ID, aspirin["id"].(string), "pick up aspirin"}} {
			res := s.ack(t, s.nishtha, c.id)
			if len(res.NotesDone) != 1 || res.NotesDone[0] != c.note {
				t.Errorf("ack %s notesDone = %v, want [%s]", c.text, res.NotesDone, c.note)
			}
			if f := hers.ackFrame(); f.ID != c.id {
				t.Errorf("Nishtha's reminder_ack = %+v", f)
			}
			notice := his.reminder()
			if notice.Kind != notify.KindAck || notice.Title != "Nishtha acknowledged "+c.text ||
				notice.Status != domain.ReminderAcknowledged || notice.FromUserID != s.nishtha.id {
				t.Errorf("Harsh's ack notice = %+v", notice)
			}
			if !s.noteDone(t, s.harsh, c.note) {
				t.Errorf("note %q not done after its only recipient acknowledged", c.text)
			}
		}
		// The ack frames went to her sessions only.
		if f := his.quiet(300 * time.Millisecond); len(f.acks) != 0 {
			t.Errorf("Harsh's socket carried Nishtha's reminder_ack: %+v", f.acks)
		}
		// Harsh's notices are history, not something waiting on him.
		if p := s.list(t, s.harsh, "?status=pending"); len(p) != 0 {
			t.Errorf("Harsh has pending reminders: %+v", p)
		}
		if a := s.list(t, s.harsh, "?status=acknowledged"); len(a) != 2 || a[0].Kind != notify.KindAck || a[1].Kind != notify.KindAck {
			t.Errorf("Harsh's acknowledged = %+v, want the two ack notices", a)
		}
	})
}

// TestOwnerAckFinishesASharedNote pins the done rule from the owner's side:
// when the owner acknowledges a note told to both of them it is done at once,
// even while the other recipient still has it pending; her record stays
// pending until she acknowledges, and only then is Harsh told.
func TestOwnerAckFinishesASharedNote(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		noteID := s.note(t, s.harsh, map[string]any{
			"text": "buy milk", "placeId": groceryID, "trigger": "passby",
			"notifyUserIds": []string{s.harsh.id, s.nishtha.id},
		})["id"].(string)

		his := s.dial(t, s.harsh)
		hers := s.dial(t, s.nishtha)
		mine := remCollect(t, s.drive(t, his, officeID)).stored()
		if len(mine) != 1 {
			t.Fatalf("Harsh got %d stored reminders, want 1", len(mine))
		}
		theirs := hers.reminderWithoutGeo()
		if theirs.ID == mine[0].ID {
			t.Fatal("the two recipients share one record")
		}

		res := s.ack(t, s.harsh, mine[0].ID)
		if len(res.NotesDone) != 1 || res.NotesDone[0] != noteID || !s.noteDone(t, s.harsh, noteID) {
			t.Fatalf("owner ack did not finish the note: %+v", res)
		}
		onlyPending(t, "Nishtha", s.list(t, s.nishtha, "?status=pending"), theirs.ID)
		if f := hers.quiet(300 * time.Millisecond); len(f.acks) != 0 {
			t.Errorf("Harsh's ack cleared Nishtha's card: %+v", f.acks)
		}

		s.ack(t, s.nishtha, theirs.ID)
		notice := his.reminder()
		if notice.Kind != notify.KindAck || notice.Title != "Nishtha acknowledged buy milk" {
			t.Errorf("owner's notice = %+v", notice)
		}
		// Idempotent: the repeat re-sends her reminder_ack (a session that
		// missed it catches up) but does not tell Harsh twice.
		hers.ackFrame()
		first := s.list(t, s.nishtha, "?status=acknowledged")[0]
		s.ack(t, s.nishtha, theirs.ID)
		if f := hers.ackFrame(); f.ID != theirs.ID || !f.AckedAt.Equal(*first.AckedAt) {
			t.Errorf("repeat reminder_ack = %+v, want the first ack time %v", f, first.AckedAt)
		}
		if again := s.list(t, s.nishtha, "?status=acknowledged")[0]; !again.AckedAt.Equal(*first.AckedAt) {
			t.Errorf("a repeat ack moved ackedAt: %v → %v", first.AckedAt, again.AckedAt)
		}
		for _, m := range his.quiet(400 * time.Millisecond).reminders {
			t.Errorf("Harsh was told again: %+v", m)
		}
		notices := 0
		for _, r := range s.list(t, s.harsh, "?status=all") {
			if r.Kind == notify.KindAck {
				notices++
			}
		}
		if notices != 1 {
			t.Errorf("Harsh has %d ack notices, want 1", notices)
		}
	})
}

// TestReminderListAndAckRules pins GET /api/v1/reminders (filters, newest
// first, limit) and the ack guard (recipient only, 404 otherwise).
func TestReminderListAndAckRules(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		pharmacyID := s.place(t, s.harsh, map[string]any{
			"name": "Pharmacy", "polygon": pharmacyRing(), "triggers": []string{"passby"},
		})
		milk := s.note(t, s.harsh, map[string]any{"text": "buy milk", "placeId": groceryID, "trigger": "passby"})["id"].(string)
		s.note(t, s.harsh, map[string]any{"text": "buy aspirin", "placeId": pharmacyID, "trigger": "passby"})

		if code, ec := s.errCode(s.harsh, http.MethodGet, "/api/v1/reminders?status=bogus", nil); code != http.StatusBadRequest || ec == "" {
			t.Errorf("status=bogus = %d %q, want 400", code, ec)
		}
		if got := s.list(t, s.harsh, ""); len(got) != 0 {
			t.Errorf("a new account lists %+v, want []", got)
		}
		if code, _ := s.call("nope", http.MethodGet, "/api/v1/reminders", nil); code != http.StatusUnauthorized {
			t.Errorf("no session = %d, want 401", code)
		}

		phone := s.dial(t, s.harsh)
		laptop := s.secondSession(s.harsh, "laptop")
		lap := s.dial(t, laptop)
		hers := s.dial(t, s.nishtha)

		// Past the grocery, then — a moment later — the pharmacy.
		s.fix(t, s.harsh, remLeaveHome[0], remLeaveHome[1], remDriving)
		s.fix(t, s.harsh, inGrocery[0], inGrocery[1], remDriving)
		first := phone.reminder()
		s.fix(t, s.harsh, remInPharmacy[0], remInPharmacy[1], remDriving)
		second := phone.reminder()
		if first.PlaceID != groceryID || second.PlaceID != pharmacyID || first.ID == "" || second.ID == "" {
			t.Fatalf("reminders = %+v then %+v", first, second)
		}
		_ = officeID

		pending := s.list(t, s.harsh, "?status=pending")
		if len(pending) != 2 || pending[0].ID != second.ID || pending[1].ID != first.ID {
			t.Fatalf("pending = %+v, want pharmacy then grocery (newest first)", pending)
		}
		if got := s.list(t, s.harsh, "?status=pending&limit=1"); len(got) != 1 || got[0].ID != second.ID {
			t.Errorf("limit=1 = %+v, want the newest", got)
		}
		if got := s.list(t, s.harsh, "?status=acknowledged"); len(got) != 0 {
			t.Errorf("acknowledged before any ack = %+v", got)
		}

		// Nobody but the recipient can acknowledge; a missing id looks the same.
		for name, path := range map[string]string{
			"Nishtha": "/api/v1/reminders/" + first.ID + "/ack",
			"missing": "/api/v1/reminders/rem_missing/ack",
		} {
			who := s.nishtha
			if name == "missing" {
				who = s.harsh
			}
			if code, _ := s.errCode(who, http.MethodPost, path, nil); code != http.StatusNotFound {
				t.Errorf("%s ack = %d, want 404", name, code)
			}
		}
		if got := s.list(t, s.nishtha, "?status=all"); len(got) != 0 {
			t.Errorf("Nishtha can list Harsh's reminders: %+v", got)
		}

		res := s.ack(t, laptop, first.ID)
		if len(res.NotesDone) != 1 || res.NotesDone[0] != milk {
			t.Errorf("notesDone = %v, want [%s]", res.NotesDone, milk)
		}
		for name, c := range map[string]*remSock{"phone": phone, "laptop": lap} {
			if f := c.ackFrame(); f.ID != first.ID {
				t.Errorf("%s reminder_ack = %+v", name, f)
			}
		}
		if f := hers.quiet(300 * time.Millisecond); len(f.acks) != 0 || len(f.reminders) != 0 {
			t.Errorf("Nishtha's socket carried Harsh's reminders: %+v", f)
		}

		if got := s.list(t, s.harsh, "?status=pending"); len(got) != 1 || got[0].ID != second.ID {
			t.Errorf("pending after one ack = %+v", got)
		}
		if got := s.list(t, s.harsh, "?status=acknowledged"); len(got) != 1 || got[0].ID != first.ID || got[0].AckedBy != s.harsh.id {
			t.Errorf("acknowledged = %+v", got)
		}
		all := s.list(t, s.harsh, "?status=all")
		if len(all) != 2 || all[0].ID != second.ID || all[1].ID != first.ID {
			t.Errorf("all = %+v, want both, newest first", all)
		}
		if def := s.list(t, s.harsh, ""); len(def) != 2 {
			t.Errorf("no status = %d reminders, want all 2", len(def))
		}
	})
}

// TestRecipientsQuietHoursAreTheirOwn pins §2/§6: each recipient's quiet hours
// hold back *their* push only. The in-app record and live frame still arrive
// (the client shows the card without a chime), and the other recipient's push
// is untouched.
func TestRecipientsQuietHoursAreTheirOwn(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		for _, u := range []remUser{s.harsh, s.nishtha} {
			s.as(u, http.MethodPost, "/api/v1/channels", map[string]any{
				"type": "ntfy", "config": map[string]string{"topic": "lura-" + u.id}, "priority": 1,
			}, http.StatusCreated)
		}
		now := time.Now().UTC()
		window := map[string]any{
			"quietFrom": now.Add(-time.Hour).Format("15:04"),
			"quietTo":   now.Add(time.Hour).Format("15:04"),
			"tz":        "UTC",
		}
		me := s.as(s.nishtha, http.MethodPatch, "/api/v1/me", window, http.StatusOK)["user"].(map[string]any)
		if me["quietFrom"] != window["quietFrom"] || me["quietTo"] != window["quietTo"] {
			t.Fatalf("quiet hours not saved: %v", me)
		}

		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		s.note(t, s.harsh, map[string]any{
			"text": "buy milk", "placeId": groceryID, "trigger": "passby",
			"notifyUserIds": []string{s.harsh.id, s.nishtha.id},
		})

		his := s.dial(t, s.harsh)
		hers := s.dial(t, s.nishtha)
		if got := remCollect(t, s.drive(t, his, officeID)).stored(); len(got) != 1 {
			t.Fatalf("Harsh's stored reminders = %d, want 1", len(got))
		}
		theirs := hers.reminderWithoutGeo()
		if theirs.ID == "" || theirs.Status != domain.ReminderPending {
			t.Errorf("Nishtha's in-app reminder during her quiet hours = %+v, want it stored and pending", theirs)
		}
		onlyPending(t, "Nishtha", s.list(t, s.nishtha, "?status=pending"), theirs.ID)

		remEventually(t, "Harsh's push", func() bool { return len(s.push.to(s.harsh.id)) == 1 })
		time.Sleep(200 * time.Millisecond)
		if got := s.push.to(s.nishtha.id); len(got) != 0 {
			t.Errorf("Nishtha was pushed during her quiet hours: %+v", got)
		}
		if got := s.push.to(s.harsh.id); len(got) != 1 || got[0].Body != "buy milk" {
			t.Errorf("Harsh's push = %+v, want one buy milk", got)
		}

		// Now the other way round: Harsh's quiet hours do not hold back hers.
		s.as(s.nishtha, http.MethodPatch, "/api/v1/me", map[string]any{"quietFrom": "", "quietTo": ""}, http.StatusOK)
		s.as(s.harsh, http.MethodPatch, "/api/v1/me", window, http.StatusOK)
		pharmacyID := s.place(t, s.harsh, map[string]any{
			"name": "Pharmacy", "polygon": pharmacyRing(), "triggers": []string{"passby"},
		})
		s.note(t, s.harsh, map[string]any{
			"text": "buy aspirin", "placeId": pharmacyID, "trigger": "passby",
			"notifyUserIds": []string{s.harsh.id, s.nishtha.id},
		})
		s.fix(t, s.harsh, remInPharmacy[0], remInPharmacy[1], remDriving)
		if m := his.reminder(); m.Body != "buy aspirin" || m.ID == "" {
			t.Errorf("Harsh's in-app reminder in his quiet hours = %+v", m)
		}
		hers.reminderWithoutGeo()
		remEventually(t, "Nishtha's push", func() bool { return len(s.push.to(s.nishtha.id)) == 1 })
		time.Sleep(200 * time.Millisecond)
		if got := s.push.to(s.harsh.id); len(got) != 1 {
			t.Errorf("Harsh was pushed in his quiet hours: %d pushes, want still 1", len(got))
		}
		if got := s.push.to(s.nishtha.id); len(got) != 1 || got[0].Body != "buy aspirin" || got[0].FromName != "Harsh" {
			t.Errorf("Nishtha's push = %+v", got)
		}
	})
}

// TestNoteRecipientsMustBeConnected pins the §2 validation on create and
// patch, and the defaults: watchUserId "" and notifyUserIds [] mean the owner.
func TestNoteRecipientsMustBeConnected(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		stranger := s.addUser(t, "usr_stranger", "stranger@lura.local", "Stranger")
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby", "arrive"},
		})

		// Invited but not accepted yet is not connected.
		s.as(s.harsh, http.MethodPost, "/api/v1/people/invite", map[string]any{"email": s.nishtha.email}, http.StatusCreated)
		for _, body := range []map[string]any{
			{"text": "x", "placeId": groceryID, "notifyUserIds": []string{s.nishtha.id}},
			{"text": "x", "placeId": groceryID, "watchUserId": s.nishtha.id},
			{"text": "x", "placeId": groceryID, "notifyUserIds": []string{s.harsh.id, stranger.id}},
			{"text": "x", "placeId": groceryID, "watchUserId": stranger.id},
		} {
			body["autoSuggest"] = false
			if code, ec := s.errCode(s.harsh, http.MethodPost, "/api/v1/notes", body); code != http.StatusBadRequest || ec != "not_connected" {
				t.Errorf("create %v = %d %q, want 400 not_connected", body, code, ec)
			}
		}

		s.as(s.nishtha, http.MethodPost, "/api/v1/people/"+s.harsh.id+"/accept", nil, http.StatusOK)
		note := s.note(t, s.harsh, map[string]any{"text": "buy milk", "placeId": groceryID, "trigger": "passby",
			"notifyUserIds": []string{}})
		id := note["id"].(string)
		if note["watchUserId"] != "" || len(note["notifyUserIds"].([]any)) != 0 {
			t.Errorf("defaults = %v", note)
		}
		for _, body := range []map[string]any{
			{"notifyUserIds": []string{stranger.id}},
			{"watchUserId": stranger.id},
		} {
			if code, ec := s.errCode(s.harsh, http.MethodPatch, "/api/v1/notes/"+id, body); code != http.StatusBadRequest || ec != "not_connected" {
				t.Errorf("patch %v = %d %q, want 400 not_connected", body, code, ec)
			}
		}
		// A refused patch changes nothing.
		got := s.as(s.harsh, http.MethodGet, "/api/v1/notes/"+id, nil, http.StatusOK)["note"].(map[string]any)
		if got["watchUserId"] != "" || len(got["notifyUserIds"].([]any)) != 0 {
			t.Errorf("a refused patch changed the note: %v", got)
		}
		patched := s.as(s.harsh, http.MethodPatch, "/api/v1/notes/"+id, map[string]any{
			"watchUserId": s.nishtha.id, "notifyUserIds": []string{s.harsh.id, s.nishtha.id},
		}, http.StatusOK)["note"].(map[string]any)
		if patched["watchUserId"] != s.nishtha.id || len(patched["notifyUserIds"].([]any)) != 2 {
			t.Errorf("patched = %v", patched)
		}

		// Nishtha cannot hang a note on Harsh's place, nor read his.
		if code, _ := s.errCode(s.nishtha, http.MethodGet, "/api/v1/notes/"+id, nil); code != http.StatusNotFound {
			t.Errorf("Nishtha reading Harsh's note = %d, want 404", code)
		}

		// After she removes him, the same patch is refused again.
		s.as(s.nishtha, http.MethodDelete, "/api/v1/people/"+s.harsh.id, nil, http.StatusNoContent)
		if code, ec := s.errCode(s.harsh, http.MethodPatch, "/api/v1/notes/"+id, map[string]any{
			"notifyUserIds": []string{s.nishtha.id},
		}); code != http.StatusBadRequest || ec != "not_connected" {
			t.Errorf("patch to a removed connection = %d %q, want 400 not_connected", code, ec)
		}
	})
}
