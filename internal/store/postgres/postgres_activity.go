package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/jackc/pgx/v5"
)

// Reminders, connection history and the windowed trigger-event read: the
// sources of the acknowledged-reminder flow and the activity feed
// (migration 0005).

const defaultActivityLimit = 500

// ---------------------------------------------------------------- trigger events

const triggerEventCols = `id, user_id, coalesce(place_id,''), place_name, device_id, trigger, ts,
	note_ids, delivered, note, subject_user_id, subject_name`

func (s *Store) queryTriggerEvents(ctx context.Context, op, sql string, args ...any) ([]domain.TriggerEvent, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		observe(op, start, err)
		return nil, mapError("list trigger events", err)
	}
	defer rows.Close()

	out := []domain.TriggerEvent{}
	for rows.Next() {
		var (
			e       domain.TriggerEvent
			trigger string
		)
		if err := rows.Scan(&e.ID, &e.UserID, &e.PlaceID, &e.PlaceName, &e.DeviceID,
			&trigger, &e.TS, &e.NoteIDs, &e.Delivered, &e.Note,
			&e.SubjectUserID, &e.SubjectName); err != nil {
			observe(op, start, err)
			return nil, mapError("scan trigger event", err)
		}
		e.Trigger = domain.Trigger(trigger)
		out = append(out, e)
	}
	err = rows.Err()
	observe(op, start, err)
	return out, mapError("list trigger events", err)
}

func (s *Store) TriggerEventsBetween(ctx context.Context, userID string, q store.RangeQuery) ([]domain.TriggerEvent, error) {
	sql, args := windowed(`SELECT `+triggerEventCols+` FROM trigger_events WHERE user_id = $1`, "ts", userID, q)
	return s.queryTriggerEvents(ctx, "TriggerEventsBetween", sql, args...)
}

// windowed appends the from/to bounds, newest-first ordering and limit.
func windowed(base, col, userID string, q store.RangeQuery) (string, []any) {
	sql := base
	args := []any{userID}
	if !q.From.IsZero() {
		args = append(args, q.From.UTC())
		sql += ` AND ` + col + ` >= $` + strconv.Itoa(len(args))
	}
	if !q.To.IsZero() {
		args = append(args, q.To.UTC())
		sql += ` AND ` + col + ` <= $` + strconv.Itoa(len(args))
	}
	limit := q.Limit
	if limit <= 0 {
		limit = defaultActivityLimit
	}
	args = append(args, limit)
	sql += ` ORDER BY ` + col + ` DESC, id DESC LIMIT $` + strconv.Itoa(len(args))
	return sql, args
}

// ---------------------------------------------------------------- reminders

const reminderCols = `id, user_id, owner_id, note_ids, place_id, place_name, trigger, kind,
	title, body, subject_user_id, subject_name, from_user_id, from_name, event_id,
	created_at, status, acked_at, acked_by`

func scanReminder(row pgx.Row) (domain.ReminderRecord, error) {
	var (
		r               domain.ReminderRecord
		trigger, status string
	)
	err := row.Scan(&r.ID, &r.UserID, &r.OwnerID, &r.NoteIDs, &r.PlaceID, &r.PlaceName,
		&trigger, &r.Kind, &r.Title, &r.Body, &r.SubjectUserID, &r.SubjectName,
		&r.FromUserID, &r.FromName, &r.EventID, &r.CreatedAt, &status, &r.AckedAt, &r.AckedBy)
	if err != nil {
		return domain.ReminderRecord{}, err
	}
	r.Trigger = domain.Trigger(trigger)
	r.Status = domain.ReminderStatus(status)
	r.CreatedAt = r.CreatedAt.UTC()
	if r.AckedAt != nil {
		t := r.AckedAt.UTC()
		r.AckedAt = &t
	}
	return r.Normalized(), nil
}

func (s *Store) SaveReminder(ctx context.Context, r domain.ReminderRecord) (domain.ReminderRecord, error) {
	start := time.Now()
	if r.UserID == "" {
		return domain.ReminderRecord{}, fmt.Errorf("reminder recipient required: %w", domain.ErrInvalid)
	}
	if r.ID == "" {
		r.ID = idgen.New("rem")
	}
	if r.CreatedAt.IsZero() {
		r.CreatedAt = time.Now()
	}
	r = r.Normalized()
	var ackedAt any
	if r.AckedAt != nil {
		ackedAt = r.AckedAt.UTC()
	}

	// ON CONFLICT on the partial (user_id, event_id) index makes a redelivered
	// event a no-op; the existing row is then read back and returned.
	row := s.pool.QueryRow(ctx, `
		INSERT INTO reminders (id, user_id, owner_id, note_ids, place_id, place_name, trigger, kind,
			title, body, subject_user_id, subject_name, from_user_id, from_name, event_id,
			created_at, status, acked_at, acked_by)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
		ON CONFLICT (user_id, event_id) WHERE event_id <> '' DO NOTHING
		RETURNING `+reminderCols,
		r.ID, r.UserID, r.OwnerID, r.NoteIDs, r.PlaceID, r.PlaceName, string(r.Trigger), r.Kind,
		r.Title, r.Body, r.SubjectUserID, r.SubjectName, r.FromUserID, r.FromName, r.EventID,
		r.CreatedAt.UTC(), string(r.Status), ackedAt, r.AckedBy)
	saved, err := scanReminder(row)
	if errors.Is(err, pgx.ErrNoRows) && r.EventID != "" {
		saved, err = scanReminder(s.pool.QueryRow(ctx,
			`SELECT `+reminderCols+` FROM reminders WHERE user_id = $1 AND event_id = $2`, r.UserID, r.EventID))
	}
	err = mapError("save reminder", err)
	observe("SaveReminder", start, err)
	return saved, err
}

func (s *Store) GetReminder(ctx context.Context, userID, id string) (domain.ReminderRecord, error) {
	start := time.Now()
	r, err := scanReminder(s.pool.QueryRow(ctx,
		`SELECT `+reminderCols+` FROM reminders WHERE id = $1 AND user_id = $2`, id, userID))
	if errors.Is(err, pgx.ErrNoRows) {
		err = fmt.Errorf("reminder %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("get reminder", err)
	observe("GetReminder", start, err)
	return r, err
}

func (s *Store) ListReminders(ctx context.Context, userID string, f store.ReminderFilter) ([]domain.ReminderRecord, error) {
	start := time.Now()
	sql := `SELECT ` + reminderCols + ` FROM reminders WHERE user_id = $1`
	args := []any{userID}
	if f.Status != "" {
		args = append(args, string(f.Status))
		sql += ` AND status = $` + strconv.Itoa(len(args))
	}
	if !f.From.IsZero() || !f.To.IsZero() {
		from, to := f.From, f.To
		if from.IsZero() {
			from = time.Unix(0, 0)
		}
		if to.IsZero() {
			to = time.Now().Add(100 * 365 * 24 * time.Hour)
		}
		args = append(args, from.UTC(), to.UTC())
		lo, hi := strconv.Itoa(len(args)-1), strconv.Itoa(len(args))
		sql += ` AND ((created_at BETWEEN $` + lo + ` AND $` + hi + `) OR (acked_at BETWEEN $` + lo + ` AND $` + hi + `))`
	}
	sql += ` ORDER BY created_at DESC, id DESC`
	if f.Limit > 0 {
		args = append(args, f.Limit)
		sql += ` LIMIT $` + strconv.Itoa(len(args))
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		observe("ListReminders", start, err)
		return nil, mapError("list reminders", err)
	}
	defer rows.Close()
	out := []domain.ReminderRecord{}
	for rows.Next() {
		r, err := scanReminder(rows)
		if err != nil {
			observe("ListReminders", start, err)
			return nil, mapError("scan reminder", err)
		}
		out = append(out, r)
	}
	err = rows.Err()
	observe("ListReminders", start, err)
	return out, mapError("list reminders", err)
}

func (s *Store) AckReminder(ctx context.Context, userID, id string, at time.Time) (domain.ReminderRecord, bool, error) {
	start := time.Now()
	// One statement is the guard: only a pending row of this recipient moves,
	// so two sessions acknowledging at once record one ack time.
	r, err := scanReminder(s.pool.QueryRow(ctx, `
		UPDATE reminders SET status = 'acknowledged', acked_at = $3, acked_by = $2
		WHERE id = $1 AND user_id = $2 AND status = 'pending'
		RETURNING `+reminderCols, id, userID, at.UTC()))
	if err == nil {
		observe("AckReminder", start, nil)
		return r, true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		err = mapError("ack reminder", err)
		observe("AckReminder", start, err)
		return domain.ReminderRecord{}, false, err
	}
	// Already acknowledged, or not this user's: GetReminder tells them apart.
	r, err = s.GetReminder(ctx, userID, id)
	observe("AckReminder", start, err)
	return r, false, err
}

func (s *Store) PendingRemindersForNote(ctx context.Context, ownerID, noteID string) (int, error) {
	start := time.Now()
	var n int
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FROM reminders
		WHERE owner_id = $1 AND status = 'pending' AND note_ids @> ARRAY[$2]::text[]`,
		ownerID, noteID).Scan(&n)
	err = mapError("count pending reminders", err)
	observe("PendingRemindersForNote", start, err)
	return n, err
}

// ---------------------------------------------------------------- connection events

func (s *Store) InsertConnectionEvent(ctx context.Context, e domain.ConnectionEvent) (domain.ConnectionEvent, error) {
	start := time.Now()
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
	_, err := s.pool.Exec(ctx, `
		INSERT INTO connection_events (id, user_id, peer_id, peer_name, action, actor_id, ts)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		e.ID, e.UserID, e.PeerID, e.PeerName, string(e.Action), e.ActorID, e.TS)
	err = mapError("insert connection event", err)
	observe("InsertConnectionEvent", start, err)
	return e, err
}

func (s *Store) ListConnectionEvents(ctx context.Context, userID string, q store.RangeQuery) ([]domain.ConnectionEvent, error) {
	start := time.Now()
	sql, args := windowed(`SELECT id, user_id, peer_id, peer_name, action, actor_id, ts
		FROM connection_events WHERE user_id = $1`, "ts", userID, q)
	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		observe("ListConnectionEvents", start, err)
		return nil, mapError("list connection events", err)
	}
	defer rows.Close()
	out := []domain.ConnectionEvent{}
	for rows.Next() {
		var (
			e      domain.ConnectionEvent
			action string
		)
		if err := rows.Scan(&e.ID, &e.UserID, &e.PeerID, &e.PeerName, &action, &e.ActorID, &e.TS); err != nil {
			observe("ListConnectionEvents", start, err)
			return nil, mapError("scan connection event", err)
		}
		e.Action = domain.ConnectionAction(action)
		e.TS = e.TS.UTC()
		out = append(out, e)
	}
	err = rows.Err()
	observe("ListConnectionEvents", start, err)
	return out, mapError("list connection events", err)
}
