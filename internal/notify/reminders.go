package notify

import (
	"context"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/bus"
	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/obs"
)

// KindAck is the owner's notice that a recipient acknowledged their note.
const KindAck = domain.ReminderKindAck

// recordFor turns a rendered message into the record stored for its
// recipient.
func recordFor(msg Message, ev domain.GeoEvent, owner string) domain.ReminderRecord {
	return domain.ReminderRecord{
		UserID:        msg.UserID,
		OwnerID:       owner,
		NoteIDs:       append([]string{}, msg.NoteIDs...),
		PlaceID:       msg.PlaceID,
		PlaceName:     msg.PlaceName,
		Trigger:       msg.Trigger,
		Kind:          msg.Kind,
		Title:         msg.Title,
		Body:          msg.Body,
		SubjectUserID: ev.Subject(),
		SubjectName:   ev.SubjectName,
		FromUserID:    msg.FromUserID,
		FromName:      msg.FromName,
		EventID:       ev.ID,
		CreatedAt:     ev.TS,
		Status:        domain.ReminderPending,
	}
}

// withRecord stamps the stored record's identity and state onto the message,
// so the live frame carries exactly what GET /api/v1/reminders returns.
func withRecord(msg Message, r domain.ReminderRecord) Message {
	created := r.CreatedAt
	msg.ID = r.ID
	msg.Status = r.Status
	msg.OwnerID = r.OwnerID
	msg.EventID = r.EventID
	msg.CreatedAt = &created
	msg.SubjectUserID = r.SubjectUserID
	msg.SubjectName = r.SubjectName
	msg.AckedAt = r.AckedAt
	msg.AckedBy = r.AckedBy
	return msg
}

// AckFrame is the reminder_ack payload published to every session of the
// recipient.
type AckFrame struct {
	ID      string    `json:"id"`
	AckedAt time.Time `json:"ackedAt"`
}

// AckResult is what acknowledging a reminder did.
type AckResult struct {
	Reminder domain.ReminderRecord `json:"reminder"`
	// NotesDone are the notes this acknowledgement marked done.
	NotesDone []string `json:"notesDone"`
}

// Acknowledge records that userID has seen reminder id.
//
//   - Only the recipient can acknowledge (anyone else gets ErrNotFound).
//   - It is idempotent: a repeat returns the stored record, re-publishes the
//     reminder_ack frame (a session that missed it catches up) and changes
//     nothing else.
//   - The first acknowledgement of someone else's note tells its owner with a
//     kind:"ack" notification, stored already acknowledged.
//   - A note is marked done when its owner acknowledges it, or when no
//     recipient has it pending any more.
func (w *Worker) Acknowledge(ctx context.Context, userID, id string) (AckResult, error) {
	ctx, span := obs.Start(ctx, "notify.acknowledge")
	defer span.End()

	rec, changed, err := w.store.AckReminder(ctx, userID, id, w.now())
	if err != nil {
		return AckResult{}, err
	}
	res := AckResult{Reminder: rec, NotesDone: []string{}}

	ackedAt := w.now().UTC()
	if rec.AckedAt != nil {
		ackedAt = *rec.AckedAt
	}
	if w.b != nil {
		if err := bus.PublishJSON(w.b, bus.ReminderAckSubject(userID), AckFrame{ID: rec.ID, AckedAt: ackedAt}); err != nil {
			w.log.WarnContext(ctx, "notify: publish reminder_ack failed", "reminder", rec.ID, "error", err)
		}
	}
	if !changed || rec.Kind == KindAck {
		return res, nil
	}

	owner := rec.OwnerID
	if owner != "" && owner != userID {
		w.tellOwner(ctx, rec)
	}

	for _, noteID := range rec.NoteIDs {
		if owner == "" {
			break
		}
		if owner != userID {
			pending, err := w.store.PendingRemindersForNote(ctx, owner, noteID)
			if err != nil {
				w.log.WarnContext(ctx, "notify: count pending reminders failed", "note", noteID, "error", err)
				continue
			}
			if pending > 0 {
				continue
			}
		}
		n, err := w.store.GetNote(ctx, owner, noteID)
		if err != nil {
			continue // deleted since: nothing to finish
		}
		if !n.Done {
			n.Done = true
			if _, err := w.store.UpdateNote(ctx, n); err != nil {
				w.log.WarnContext(ctx, "notify: mark note done failed", "note", noteID, "error", err)
				continue
			}
		}
		res.NotesDone = append(res.NotesDone, noteID)
	}
	return res, nil
}

// inlineNotes reads a reminder body as one line: render lists several notes a
// line each ("• buy aspirin\n• pick up the prescription"), and an
// acknowledgement notice says them inline ("buy aspirin, pick up the
// prescription") rather than falling back to the crossing's title.
func inlineNotes(body string) string {
	var parts []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(line), "•"))
		if line != "" {
			parts = append(parts, line)
		}
	}
	return strings.Join(parts, ", ")
}

// tellOwner stores and publishes "Nishtha acknowledged buy milk" for the note
// owner. It is in-app only: an acknowledgement is news, not a reminder, so it
// does not push to the owner's phone.
func (w *Worker) tellOwner(ctx context.Context, rec domain.ReminderRecord) {
	name := w.nameOf(ctx, rec.UserID)
	if name == "" {
		name = "Someone"
	}
	what := inlineNotes(rec.Body)
	if what == "" {
		what = rec.Title
	}
	notice, err := w.store.SaveReminder(ctx, domain.ReminderRecord{
		UserID:        rec.OwnerID,
		OwnerID:       rec.OwnerID,
		NoteIDs:       append([]string{}, rec.NoteIDs...),
		PlaceID:       rec.PlaceID,
		PlaceName:     rec.PlaceName,
		Trigger:       rec.Trigger,
		Kind:          KindAck,
		Title:         name + " acknowledged " + what,
		Body:          rec.Body,
		SubjectUserID: rec.SubjectUserID,
		SubjectName:   rec.SubjectName,
		FromUserID:    rec.UserID,
		FromName:      name,
		CreatedAt:     *rec.AckedAt,
		Status:        domain.ReminderAcknowledged,
		AckedAt:       rec.AckedAt,
		AckedBy:       rec.UserID,
	})
	if err != nil {
		w.log.WarnContext(ctx, "notify: store ack notice failed", "reminder", rec.ID, "error", err)
		return
	}
	msg := withRecord(Message{
		UserID:     notice.UserID,
		Title:      notice.Title,
		Body:       notice.Body,
		Trigger:    notice.Trigger,
		PlaceID:    notice.PlaceID,
		PlaceName:  notice.PlaceName,
		NoteIDs:    notice.NoteIDs,
		Tags:       []string{},
		Priority:   3,
		TS:         notice.CreatedAt,
		Kind:       KindAck,
		FromUserID: notice.FromUserID,
		FromName:   notice.FromName,
	}, notice)
	w.mu.RLock()
	inapp, ok := w.notifiers["inapp"]
	w.mu.RUnlock()
	if !ok {
		if w.b == nil {
			return
		}
		inapp = &InApp{Bus: w.b}
	}
	if err := inapp.Send(ctx, msg); err != nil {
		w.log.WarnContext(ctx, "notify: publish ack notice failed", "error", err)
	}
}
