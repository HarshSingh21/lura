package httpapi_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/notify"
)

// TestReminderAckEdgeCases pins the ack rules where the world moved on after
// delivery: a note deleted while its reminder is pending, a connection removed
// while her reminder is pending, and two tabs acknowledging at once.
func TestReminderAckEdgeCases(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		officeID := s.place(t, s.harsh, remCircle("Office", remOffice, "arrive"))
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"passby"},
		})
		pharmacyID := s.place(t, s.harsh, map[string]any{
			"name": "Pharmacy", "polygon": pharmacyRing(), "triggers": []string{"passby"},
		})
		milk := s.note(t, s.harsh, map[string]any{
			"text": "buy milk", "placeId": groceryID, "trigger": "passby",
			"notifyUserIds": []string{s.harsh.id, s.nishtha.id},
		})["id"].(string)
		aspirin := s.note(t, s.harsh, map[string]any{
			"text": "buy aspirin", "placeId": pharmacyID, "trigger": "passby",
		})["id"].(string)

		his := s.dial(t, s.harsh)
		tab1 := s.dial(t, s.nishtha)
		tab2User := s.secondSession(s.nishtha, "tab2")
		tab2 := s.dial(t, tab2User)

		// Home → past the grocery → past the pharmacy → Office.
		s.fix(t, s.harsh, remLeaveHome[0], remLeaveHome[1], remDriving)
		s.fix(t, s.harsh, inGrocery[0], inGrocery[1], remDriving)
		s.fix(t, s.harsh, remInPharmacy[0], remInPharmacy[1], remDriving)
		s.fix(t, s.harsh, remOffice[0], remOffice[1], 0.5)
		var hisMilk, hisAspirin string
		for _, m := range remCollect(t, his.notifiedAt(officeID, domain.TriggerArrive)).stored() {
			switch m.PlaceID {
			case groceryID:
				hisMilk = m.ID
			case pharmacyID:
				hisAspirin = m.ID
			}
		}
		if hisMilk == "" || hisAspirin == "" {
			t.Fatalf("Harsh's reminders: milk %q aspirin %q", hisMilk, hisAspirin)
		}
		hersMilk := tab1.reminderWithoutGeo()
		tab2.reminderWithoutGeo()

		// ---- a deleted note's reminder can still be acknowledged.
		s.as(s.harsh, http.MethodDelete, "/api/v1/notes/"+aspirin, nil, http.StatusNoContent)
		stillThere := false
		for _, r := range s.list(t, s.harsh, "?status=pending") {
			stillThere = stillThere || r.ID == hisAspirin
		}
		if !stillThere {
			t.Error("deleting the note dropped its pending reminder")
		}
		if res := s.ack(t, s.harsh, hisAspirin); len(res.NotesDone) != 0 || res.Reminder.Status != domain.ReminderAcknowledged {
			t.Errorf("ack of a deleted note's reminder = %+v", res)
		}
		if f := his.ackFrame(); f.ID != hisAspirin {
			t.Errorf("reminder_ack = %+v", f)
		}

		// ---- she removes him; her reminder stays hers to acknowledge, privately.
		s.as(s.nishtha, http.MethodDelete, "/api/v1/people/"+s.harsh.id, nil, http.StatusNoContent)
		onlyPending(t, "Nishtha after removing Harsh", s.list(t, s.nishtha, "?status=pending"), hersMilk.ID)

		// Both of her tabs press Acknowledge at once.
		results := make(chan notify.AckResult, 2)
		for _, u := range []remUser{s.nishtha, tab2User} {
			go func(u remUser) {
				var res notify.AckResult
				if code, raw := s.call(u.token, http.MethodPost, "/api/v1/reminders/"+hersMilk.ID+"/ack", nil); code == http.StatusOK {
					_ = json.Unmarshal(raw, &res)
				}
				results <- res
			}(u)
		}
		a, b := <-results, <-results
		if a.Reminder.AckedAt == nil || b.Reminder.AckedAt == nil || !a.Reminder.AckedAt.Equal(*b.Reminder.AckedAt) {
			t.Errorf("concurrent acks disagree on the ack time: %+v vs %+v", a.Reminder, b.Reminder)
		}
		if len(a.NotesDone)+len(b.NotesDone) != 0 {
			t.Errorf("her ack after removal finished Harsh's note: %v %v", a.NotesDone, b.NotesDone)
		}
		for _, tab := range []*remSock{tab1, tab2} {
			if f := tab.ackFrame(); f.ID != hersMilk.ID {
				t.Errorf("reminder_ack = %+v", f)
			}
		}
		for _, m := range his.quiet(500 * time.Millisecond).reminders {
			t.Errorf("Harsh heard from someone who removed him: %+v", m)
		}
		if s.noteDone(t, s.harsh, milk) {
			t.Error("note done while its owner still has it pending")
		}
		if res := s.ack(t, s.harsh, hisMilk); len(res.NotesDone) != 1 || res.NotesDone[0] != milk {
			t.Errorf("owner ack notesDone = %v", res.NotesDone)
		}
	})
}

// TestWatchReminderWaitsForTheWatcher pins §3/§6 for a fence that watches a
// person with no note: Harsh's "watch" reminder about Nishtha is a pending
// record of his alone, survives a restart, and acknowledging it tells nobody.
func TestWatchReminderWaitsForTheWatcher(t *testing.T) {
	remEachBackend(t, func(t *testing.T, s *remStack) {
		s.connect(t)
		groceryID := s.place(t, s.harsh, map[string]any{
			"name": "Grocery", "polygon": groceryRing(), "triggers": []string{"arrive"},
			"watchUserIds": []string{s.nishtha.id},
		})
		his := s.dial(t, s.harsh)
		hers := s.dial(t, s.nishtha)

		s.fix(t, s.nishtha, nearGrocery[0], nearGrocery[1], 1)
		s.fix(t, s.nishtha, inGrocery[0], inGrocery[1], 0.5)
		w := his.reminder()
		if w.Kind != notify.KindWatch || w.ID == "" || w.Status != domain.ReminderPending ||
			w.Title != "Nishtha arrived at Grocery" || w.SubjectUserID != s.nishtha.id || w.PlaceID != groceryID || len(w.NoteIDs) != 0 {
			t.Fatalf("watch reminder = %+v", w)
		}
		if f := hers.quiet(400 * time.Millisecond); len(f.reminders) != 0 || len(f.geo) != 0 {
			t.Errorf("the watched person was told: %+v", f)
		}
		if got := s.list(t, s.nishtha, "?status=all"); len(got) != 0 {
			t.Errorf("Nishtha has records of being watched: %+v", got)
		}

		s.restart(t)
		onlyPending(t, "Harsh after restart", s.list(t, s.harsh, "?status=pending"), w.ID)
		his = s.dial(t, s.harsh)
		hers = s.dial(t, s.nishtha)
		if res := s.ack(t, s.harsh, w.ID); len(res.NotesDone) != 0 || res.Reminder.Kind != notify.KindWatch {
			t.Errorf("ack = %+v", res)
		}
		if f := his.ackFrame(); f.ID != w.ID {
			t.Errorf("reminder_ack = %+v", f)
		}
		if f := hers.quiet(400 * time.Millisecond); len(f.reminders) != 0 || len(f.acks) != 0 {
			t.Errorf("Nishtha heard of Harsh's ack: %+v", f)
		}
	})
}
