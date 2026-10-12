package memory

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
)

// ---------------------------------------------------------------- reminders

func (s *Store) SaveReminder(_ context.Context, r domain.ReminderRecord) (domain.ReminderRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.UserID == "" {
		return domain.ReminderRecord{}, fmt.Errorf("reminder recipient required: %w", domain.ErrInvalid)
	}
	if r.EventID != "" {
		for _, prev := range s.reminders {
			if prev.UserID == r.UserID && prev.EventID == r.EventID {
				return cloneReminder(prev), nil
			}
		}
	}
	if r.ID == "" {
		r.ID = idgen.New("rem")
	}
	if _, exists := s.reminders[r.ID]; exists {
		return domain.ReminderRecord{}, fmt.Errorf("reminder %s: %w", r.ID, domain.ErrConflict)
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now()
	}
	// Microsecond precision, like timestamptz, so both stores hand back equal values.
	r.CreatedAt = r.CreatedAt.UTC().Truncate(time.Microsecond)
	if r.AckedAt != nil {
		t := r.AckedAt.UTC().Truncate(time.Microsecond)
		r.AckedAt = &t
	}
	r = r.Normalized()
	s.reminders[r.ID] = cloneReminder(r)
	return cloneReminder(r), nil
}

func (s *Store) GetReminder(_ context.Context, userID, id string) (domain.ReminderRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	r, ok := s.reminders[id]
	if !ok || r.UserID != userID {
		return domain.ReminderRecord{}, fmt.Errorf("reminder %s: %w", id, domain.ErrNotFound)
	}
	return cloneReminder(r), nil
}

func (s *Store) ListReminders(_ context.Context, userID string, f store.ReminderFilter) ([]domain.ReminderRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.ReminderRecord{}
	for _, r := range s.reminders {
		if r.UserID != userID {
			continue
		}
		if f.Status != "" && r.Status != f.Status {
			continue
		}
		if !f.From.IsZero() || !f.To.IsZero() {
			in := inRange(r.CreatedAt, f.From, f.To) || (r.AckedAt != nil && inRange(*r.AckedAt, f.From, f.To))
			if !in {
				continue
			}
		}
		out = append(out, cloneReminder(r))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt.Equal(out[j].CreatedAt) {
			return out[i].ID > out[j].ID
		}
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	if f.Limit > 0 && len(out) > f.Limit {
		out = out[:f.Limit]
	}
	return out, nil
}

func (s *Store) AckReminder(_ context.Context, userID, id string, at time.Time) (domain.ReminderRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.reminders[id]
	if !ok || r.UserID != userID {
		return domain.ReminderRecord{}, false, fmt.Errorf("reminder %s: %w", id, domain.ErrNotFound)
	}
	if r.Status == domain.ReminderAcknowledged {
		return cloneReminder(r), false, nil
	}
	t := at.UTC().Truncate(time.Microsecond)
	r.Status = domain.ReminderAcknowledged
	r.AckedAt = &t
	r.AckedBy = userID
	s.reminders[id] = r
	return cloneReminder(r), true, nil
}

func (s *Store) PendingRemindersForNote(_ context.Context, ownerID, noteID string) (int, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, r := range s.reminders {
		if r.OwnerID != ownerID || r.Status != domain.ReminderPending {
			continue
		}
		for _, id := range r.NoteIDs {
			if id == noteID {
				n++
				break
			}
		}
	}
	return n, nil
}

// ---------------------------------------------------------------- activity sources

func (s *Store) TriggerEventsBetween(_ context.Context, userID string, q store.RangeQuery) ([]domain.TriggerEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.TriggerEvent{}
	for _, e := range s.events {
		if e.UserID == userID && inRange(e.TS, q.From, q.To) {
			out = append(out, cloneEvent(e))
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS.After(out[j].TS) })
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

func (s *Store) InsertConnectionEvent(_ context.Context, e domain.ConnectionEvent) (domain.ConnectionEvent, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.UserID == "" || e.PeerID == "" || e.Action == "" {
		return domain.ConnectionEvent{}, fmt.Errorf("connection event needs user, peer and action: %w", domain.ErrInvalid)
	}
	if e.ID == "" {
		e.ID = idgen.New("cev")
	}
	if e.TS.IsZero() {
		e.TS = time.Now()
	}
	e.TS = e.TS.UTC().Truncate(time.Microsecond)
	s.connEvts = append(s.connEvts, e)
	if len(s.connEvts) > 5000 {
		s.connEvts = append([]domain.ConnectionEvent(nil), s.connEvts[len(s.connEvts)-5000:]...)
	}
	return e, nil
}

func (s *Store) ListConnectionEvents(_ context.Context, userID string, q store.RangeQuery) ([]domain.ConnectionEvent, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := []domain.ConnectionEvent{}
	for _, e := range s.connEvts {
		if e.UserID == userID && inRange(e.TS, q.From, q.To) {
			out = append(out, e)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS.After(out[j].TS) })
	if q.Limit > 0 && len(out) > q.Limit {
		out = out[:q.Limit]
	}
	return out, nil
}

func inRange(t, from, to time.Time) bool {
	if !from.IsZero() && t.Before(from) {
		return false
	}
	if !to.IsZero() && t.After(to) {
		return false
	}
	return true
}

func cloneReminder(r domain.ReminderRecord) domain.ReminderRecord {
	r.NoteIDs = cloneStrings(r.NoteIDs)
	if r.AckedAt != nil {
		t := *r.AckedAt
		r.AckedAt = &t
	}
	return r
}
