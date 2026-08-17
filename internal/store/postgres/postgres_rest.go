package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/jackc/pgx/v5"
)

// ---------------------------------------------------------------- places

const placeCols = `id, user_id, name, tags,
	ST_Y(center::geometry), ST_X(center::geometry),
	radius_m, triggers, dwell_mins, created_at, updated_at`

func scanPlace(row pgx.Row) (domain.Place, error) {
	var (
		p        domain.Place
		triggers []string
	)
	err := row.Scan(&p.ID, &p.UserID, &p.Name, &p.Tags,
		&p.Center.Lat, &p.Center.Lon,
		&p.RadiusM, &triggers, &p.DwellMins, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return domain.Place{}, err
	}
	p.Triggers = make([]domain.Trigger, 0, len(triggers))
	for _, t := range triggers {
		p.Triggers = append(p.Triggers, domain.Trigger(t))
	}
	return p, nil
}

// arr normalises a Go slice for an array column.
//
// A nil slice binds as SQL NULL, and every array column here is NOT NULL with a
// '{}' default — so a note created without tags fails on the real database while
// passing against the in-memory store. Normalising at the boundary keeps the two
// implementations interchangeable, which is what storetest asserts.
func arr(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func triggerStrings(ts []domain.Trigger) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, string(t))
	}
	return out
}

func (s *Store) ListPlaces(ctx context.Context, userID string) ([]domain.Place, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx,
		`SELECT `+placeCols+` FROM places WHERE user_id = $1 ORDER BY created_at, id`, userID)
	if err != nil {
		observe("ListPlaces", start, err)
		return nil, mapError("list places", err)
	}
	defer rows.Close()

	out := []domain.Place{}
	for rows.Next() {
		p, err := scanPlace(rows)
		if err != nil {
			observe("ListPlaces", start, err)
			return nil, mapError("scan place", err)
		}
		out = append(out, p)
	}
	err = rows.Err()
	observe("ListPlaces", start, err)
	return out, mapError("list places", err)
}

func (s *Store) GetPlace(ctx context.Context, userID, id string) (domain.Place, error) {
	start := time.Now()
	p, err := scanPlace(s.pool.QueryRow(ctx,
		`SELECT `+placeCols+` FROM places WHERE id = $1 AND user_id = $2`, id, userID))
	err = mapError("place "+id, err)
	observe("GetPlace", start, err)
	return p, err
}

func (s *Store) CreatePlace(ctx context.Context, p domain.Place) (domain.Place, error) {
	start := time.Now()
	if p.ID == "" {
		p.ID = idgen.New("plc")
	}
	if p.CreatedAt.IsZero() {
		p.CreatedAt = time.Now().UTC()
	}
	out, err := scanPlace(s.pool.QueryRow(ctx, `
		INSERT INTO places (id, user_id, name, tags, center, radius_m, triggers, dwell_mins, created_at, updated_at)
		VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, $7,$8,$9,$10, now())
		RETURNING `+placeCols,
		p.ID, p.UserID, p.Name, arr(p.Tags), p.Center.Lon, p.Center.Lat,
		p.RadiusM, triggerStrings(p.Triggers), p.DwellMins, p.CreatedAt))
	err = mapError("create place", err)
	observe("CreatePlace", start, err)
	return out, err
}

// UpdatePlace always stamps updated_at, because that column is the AI Brain's
// embedding-cache key (HLD §5.7): if a rename did not move it, a stale embedding
// could still match the old label.
func (s *Store) UpdatePlace(ctx context.Context, p domain.Place) (domain.Place, error) {
	start := time.Now()
	out, err := scanPlace(s.pool.QueryRow(ctx, `
		UPDATE places SET
			name = $3,
			tags = $4,
			center = ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,
			radius_m = $7,
			triggers = $8,
			dwell_mins = $9,
			updated_at = now()
		WHERE id = $1 AND user_id = $2
		RETURNING `+placeCols,
		p.ID, p.UserID, p.Name, arr(p.Tags), p.Center.Lon, p.Center.Lat,
		p.RadiusM, triggerStrings(p.Triggers), p.DwellMins))
	err = mapError("place "+p.ID, err)
	observe("UpdatePlace", start, err)
	return out, err
}

func (s *Store) DeletePlace(ctx context.Context, userID, id string) error {
	start := time.Now()
	// Notes fall back to unbound (ON DELETE SET NULL) and pending dwells cascade,
	// both declared in the schema: deleting a geofence must not delete the user's
	// words.
	tag, err := s.pool.Exec(ctx, `DELETE FROM places WHERE id = $1 AND user_id = $2`, id, userID)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("place %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("delete place", err)
	observe("DeletePlace", start, err)
	return err
}

// PlacesContaining is the geofence hot path: ST_DWithin over the GIST index,
// which is the query the Phase 1 engine runs for every incoming fix.
func (s *Store) PlacesContaining(ctx context.Context, userID string, pt domain.Point) ([]domain.Place, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT `+placeCols+`
		FROM places
		WHERE user_id = $1
		  AND ST_DWithin(center, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, radius_m)
		ORDER BY id`, userID, pt.Lon, pt.Lat)
	if err != nil {
		observe("PlacesContaining", start, err)
		return nil, mapError("places containing", err)
	}
	defer rows.Close()

	out := []domain.Place{}
	for rows.Next() {
		p, err := scanPlace(rows)
		if err != nil {
			observe("PlacesContaining", start, err)
			return nil, mapError("scan place", err)
		}
		out = append(out, p)
	}
	err = rows.Err()
	observe("PlacesContaining", start, err)
	return out, mapError("places containing", err)
}

// PlaceStats counts notes and fired events per place in one round trip rather
// than N+1 queries behind the places grid.
func (s *Store) PlaceStats(ctx context.Context, userID string) (map[string]store.PlaceStats, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT p.id,
		       (SELECT count(*) FROM notes n WHERE n.place_id = p.id AND n.user_id = p.user_id),
		       (SELECT count(*) FROM trigger_events e WHERE e.place_id = p.id AND e.user_id = p.user_id)
		FROM places p
		WHERE p.user_id = $1`, userID)
	if err != nil {
		observe("PlaceStats", start, err)
		return nil, mapError("place stats", err)
	}
	defer rows.Close()

	out := map[string]store.PlaceStats{}
	for rows.Next() {
		var (
			id            string
			notes, events int
		)
		if err := rows.Scan(&id, &notes, &events); err != nil {
			observe("PlaceStats", start, err)
			return nil, mapError("scan place stats", err)
		}
		out[id] = store.PlaceStats{Notes: notes, Events: events}
	}
	err = rows.Err()
	observe("PlaceStats", start, err)
	return out, mapError("place stats", err)
}

// ---------------------------------------------------------------- notes

// The column is `body`, not `text`: `text` is a type name in PostgreSQL and
// quoting it everywhere is a papercut waiting to become a bug.
const noteCols = `id, user_id, body, coalesce(place_id, ''), trigger, tags, done, channel,
	created_at, updated_at, fired_at`

func scanNote(row pgx.Row) (domain.Note, error) {
	var (
		n       domain.Note
		trigger string
	)
	err := row.Scan(&n.ID, &n.UserID, &n.Text, &n.PlaceID, &trigger, &n.Tags,
		&n.Done, &n.Channel, &n.CreatedAt, &n.UpdatedAt, &n.FiredAt)
	if err != nil {
		return domain.Note{}, err
	}
	n.Trigger = domain.Trigger(trigger)
	return n, nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) ListNotes(ctx context.Context, userID string, f store.NoteFilter) ([]domain.Note, error) {
	start := time.Now()

	sql := `SELECT ` + noteCols + ` FROM notes WHERE user_id = $1`
	args := []any{userID}
	if f.PlaceID != "" {
		args = append(args, f.PlaceID)
		sql += fmt.Sprintf(" AND place_id = $%d", len(args))
	}
	if f.Trigger != "" {
		args = append(args, string(f.Trigger))
		sql += fmt.Sprintf(" AND trigger = $%d", len(args))
	}
	if f.Done != nil {
		args = append(args, *f.Done)
		sql += fmt.Sprintf(" AND done = $%d", len(args))
	}
	// Open notes first — that is what the user has to act on — then oldest first
	// within each group, matching the list order the UI shows.
	sql += " ORDER BY done, created_at, id"
	if f.Limit > 0 {
		args = append(args, f.Limit)
		sql += fmt.Sprintf(" LIMIT $%d", len(args))
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		observe("ListNotes", start, err)
		return nil, mapError("list notes", err)
	}
	defer rows.Close()

	out := []domain.Note{}
	for rows.Next() {
		n, err := scanNote(rows)
		if err != nil {
			observe("ListNotes", start, err)
			return nil, mapError("scan note", err)
		}
		out = append(out, n)
	}
	err = rows.Err()
	observe("ListNotes", start, err)
	return out, mapError("list notes", err)
}

func (s *Store) GetNote(ctx context.Context, userID, id string) (domain.Note, error) {
	start := time.Now()
	n, err := scanNote(s.pool.QueryRow(ctx,
		`SELECT `+noteCols+` FROM notes WHERE id = $1 AND user_id = $2`, id, userID))
	err = mapError("note "+id, err)
	observe("GetNote", start, err)
	return n, err
}

func (s *Store) CreateNote(ctx context.Context, n domain.Note) (domain.Note, error) {
	start := time.Now()
	if n.ID == "" {
		n.ID = idgen.New("not")
	}
	if n.CreatedAt.IsZero() {
		n.CreatedAt = time.Now().UTC()
	}
	out, err := scanNote(s.pool.QueryRow(ctx, `
		INSERT INTO notes (id, user_id, body, place_id, trigger, tags, done, channel, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
		RETURNING `+noteCols,
		n.ID, n.UserID, n.Text, nullable(n.PlaceID), string(n.Trigger), arr(n.Tags), n.Done, n.Channel, n.CreatedAt))
	err = mapError("create note", err)
	observe("CreateNote", start, err)
	return out, err
}

func (s *Store) UpdateNote(ctx context.Context, n domain.Note) (domain.Note, error) {
	start := time.Now()
	out, err := scanNote(s.pool.QueryRow(ctx, `
		UPDATE notes SET
			body = $3, place_id = $4, trigger = $5, tags = $6,
			done = $7, channel = $8, updated_at = now()
		WHERE id = $1 AND user_id = $2
		RETURNING `+noteCols,
		n.ID, n.UserID, n.Text, nullable(n.PlaceID), string(n.Trigger), arr(n.Tags), n.Done, n.Channel))
	err = mapError("note "+n.ID, err)
	observe("UpdateNote", start, err)
	return out, err
}

func (s *Store) DeleteNote(ctx context.Context, userID, id string) error {
	start := time.Now()
	tag, err := s.pool.Exec(ctx, `DELETE FROM notes WHERE id = $1 AND user_id = $2`, id, userID)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("note %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("delete note", err)
	observe("DeleteNote", start, err)
	return err
}

func (s *Store) MarkNoteFired(ctx context.Context, userID, id string, at time.Time) error {
	start := time.Now()
	tag, err := s.pool.Exec(ctx,
		`UPDATE notes SET fired_at = $3, updated_at = now() WHERE id = $1 AND user_id = $2`,
		id, userID, at.UTC())
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("note %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("mark note fired", err)
	observe("MarkNoteFired", start, err)
	return err
}

// ---------------------------------------------------------------- shares

const shareCols = `id, user_id, token, label, mode, device_ids, expires_at,
	coalesce(arrive_place, ''), revoked_at, revoke_reason, created_at`

func scanShare(row pgx.Row) (domain.Share, error) {
	var (
		sh   domain.Share
		mode string
	)
	err := row.Scan(&sh.ID, &sh.UserID, &sh.Token, &sh.Label, &mode, &sh.DeviceIDs,
		&sh.ExpiresAt, &sh.ArrivePlace, &sh.RevokedAt, &sh.RevokeReason, &sh.CreatedAt)
	if err != nil {
		return domain.Share{}, err
	}
	sh.Mode = domain.ShareMode(mode)
	return sh, nil
}

func (s *Store) ListShares(ctx context.Context, userID string, includeInactive bool) ([]domain.Share, error) {
	start := time.Now()

	sql := `SELECT ` + shareCols + ` FROM shares WHERE user_id = $1`
	if !includeInactive {
		// Expiry is enforced in the query as well as in the service, so a stale
		// row can never present itself as an active share.
		sql += ` AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
	}
	sql += ` ORDER BY created_at DESC`

	rows, err := s.pool.Query(ctx, sql, userID)
	if err != nil {
		observe("ListShares", start, err)
		return nil, mapError("list shares", err)
	}
	defer rows.Close()

	out := []domain.Share{}
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			observe("ListShares", start, err)
			return nil, mapError("scan share", err)
		}
		out = append(out, sh)
	}
	err = rows.Err()
	observe("ListShares", start, err)
	return out, mapError("list shares", err)
}

func (s *Store) CreateShare(ctx context.Context, sh domain.Share) (domain.Share, error) {
	start := time.Now()
	if sh.ID == "" {
		sh.ID = idgen.New("shr")
	}
	if sh.Token == "" {
		sh.Token = idgen.ShortToken()
	}
	if sh.CreatedAt.IsZero() {
		sh.CreatedAt = time.Now().UTC()
	}
	sh.DeviceIDs = arr(sh.DeviceIDs)
	out, err := scanShare(s.pool.QueryRow(ctx, `
		INSERT INTO shares (id, user_id, token, label, mode, device_ids, expires_at, arrive_place, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		RETURNING `+shareCols,
		sh.ID, sh.UserID, sh.Token, sh.Label, string(sh.Mode), sh.DeviceIDs,
		sh.ExpiresAt, nullable(sh.ArrivePlace), sh.CreatedAt))
	err = mapError("create share", err)
	observe("CreateShare", start, err)
	return out, err
}

func (s *Store) ShareByToken(ctx context.Context, token string) (domain.Share, error) {
	start := time.Now()
	sh, err := scanShare(s.pool.QueryRow(ctx,
		`SELECT `+shareCols+` FROM shares WHERE token = $1`, token))
	err = mapError("share token", err)
	observe("ShareByToken", start, err)
	return sh, err
}

// RevokeShare is idempotent: revoking twice keeps the first reason and timestamp,
// so an auto-revoke racing a manual one cannot rewrite history.
func (s *Store) RevokeShare(ctx context.Context, userID, id, reason string, at time.Time) (domain.Share, error) {
	start := time.Now()
	sh, err := scanShare(s.pool.QueryRow(ctx, `
		UPDATE shares
		SET revoked_at = coalesce(revoked_at, $3),
		    revoke_reason = CASE WHEN revoked_at IS NULL THEN $4 ELSE revoke_reason END
		WHERE id = $1 AND user_id = $2
		RETURNING `+shareCols,
		id, userID, at.UTC(), reason))
	err = mapError("share "+id, err)
	observe("RevokeShare", start, err)
	return sh, err
}

func (s *Store) SharesForArrivePlace(ctx context.Context, userID, placeID string) ([]domain.Share, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT `+shareCols+`
		FROM shares
		WHERE user_id = $1 AND arrive_place = $2 AND mode = $3
		  AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
		userID, placeID, string(domain.ShareUntilArrive))
	if err != nil {
		observe("SharesForArrivePlace", start, err)
		return nil, mapError("shares for arrive place", err)
	}
	defer rows.Close()

	out := []domain.Share{}
	for rows.Next() {
		sh, err := scanShare(rows)
		if err != nil {
			observe("SharesForArrivePlace", start, err)
			return nil, mapError("scan share", err)
		}
		out = append(out, sh)
	}
	err = rows.Err()
	observe("SharesForArrivePlace", start, err)
	return out, mapError("shares for arrive place", err)
}

// ---------------------------------------------------------------- channels

func (s *Store) ListChannels(ctx context.Context, userID string) ([]domain.Channel, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, type, config, enabled, priority, created_at
		FROM channels WHERE user_id = $1 ORDER BY priority, created_at`, userID)
	if err != nil {
		observe("ListChannels", start, err)
		return nil, mapError("list channels", err)
	}
	defer rows.Close()

	out := []domain.Channel{}
	for rows.Next() {
		var (
			c   domain.Channel
			raw []byte
		)
		if err := rows.Scan(&c.ID, &c.UserID, &c.Type, &raw, &c.Enabled, &c.Priority, &c.CreatedAt); err != nil {
			observe("ListChannels", start, err)
			return nil, mapError("scan channel", err)
		}
		c.Config = map[string]string{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &c.Config); err != nil {
				// A malformed config row should not hide the channel entirely; the
				// notifier will fail loudly if it actually needs the setting.
				s.log.Warn("channel config unreadable", "channel", c.ID, "error", err)
			}
		}
		out = append(out, c)
	}
	err = rows.Err()
	observe("ListChannels", start, err)
	return out, mapError("list channels", err)
}

func (s *Store) CreateChannel(ctx context.Context, c domain.Channel) (domain.Channel, error) {
	start := time.Now()
	if c.ID == "" {
		c.ID = idgen.New("chn")
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}
	cfg, err := json.Marshal(orEmpty(c.Config))
	if err != nil {
		return domain.Channel{}, fmt.Errorf("channel config: %w", domain.ErrInvalid)
	}
	_, err = s.pool.Exec(ctx, `
		INSERT INTO channels (id, user_id, type, config, enabled, priority, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7)`,
		c.ID, c.UserID, c.Type, cfg, c.Enabled, c.Priority, c.CreatedAt)
	err = mapError("create channel", err)
	observe("CreateChannel", start, err)
	return c, err
}

func (s *Store) UpdateChannel(ctx context.Context, c domain.Channel) (domain.Channel, error) {
	start := time.Now()
	cfg, err := json.Marshal(orEmpty(c.Config))
	if err != nil {
		return domain.Channel{}, fmt.Errorf("channel config: %w", domain.ErrInvalid)
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE channels SET type = $3, config = $4, enabled = $5, priority = $6
		WHERE id = $1 AND user_id = $2`,
		c.ID, c.UserID, c.Type, cfg, c.Enabled, c.Priority)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("channel %s: %w", c.ID, domain.ErrNotFound)
	}
	err = mapError("update channel", err)
	observe("UpdateChannel", start, err)
	return c, err
}

func (s *Store) DeleteChannel(ctx context.Context, userID, id string) error {
	start := time.Now()
	tag, err := s.pool.Exec(ctx, `DELETE FROM channels WHERE id = $1 AND user_id = $2`, id, userID)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("channel %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("delete channel", err)
	observe("DeleteChannel", start, err)
	return err
}

func orEmpty(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// ---------------------------------------------------------------- trigger events

func (s *Store) InsertTriggerEvent(ctx context.Context, e domain.TriggerEvent) (domain.TriggerEvent, error) {
	start := time.Now()
	if e.ID == "" {
		e.ID = idgen.New("evt")
	}
	if e.TS.IsZero() {
		e.TS = time.Now().UTC()
	}
	e.NoteIDs = arr(e.NoteIDs)
	e.Delivered = arr(e.Delivered)
	_, err := s.pool.Exec(ctx, `
		INSERT INTO trigger_events (id, user_id, place_id, place_name, device_id, trigger, ts, note_ids, delivered, note)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		e.ID, e.UserID, nullable(e.PlaceID), e.PlaceName, e.DeviceID,
		string(e.Trigger), e.TS.UTC(), e.NoteIDs, e.Delivered, e.Note)
	err = mapError("insert trigger event", err)
	observe("InsertTriggerEvent", start, err)
	return e, err
}

func (s *Store) ListTriggerEvents(ctx context.Context, userID string, limit int) ([]domain.TriggerEvent, error) {
	start := time.Now()
	if limit <= 0 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT id, user_id, coalesce(place_id,''), place_name, device_id, trigger, ts, note_ids, delivered, note
		FROM trigger_events
		WHERE user_id = $1
		ORDER BY ts DESC
		LIMIT $2`, userID, limit)
	if err != nil {
		observe("ListTriggerEvents", start, err)
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
			&trigger, &e.TS, &e.NoteIDs, &e.Delivered, &e.Note); err != nil {
			observe("ListTriggerEvents", start, err)
			return nil, mapError("scan trigger event", err)
		}
		e.Trigger = domain.Trigger(trigger)
		out = append(out, e)
	}
	err = rows.Err()
	observe("ListTriggerEvents", start, err)
	return out, mapError("list trigger events", err)
}

// ---------------------------------------------------------------- pending dwells

func (s *Store) PutPendingDwell(ctx context.Context, d domain.PendingDwell) error {
	start := time.Now()
	// Re-arming an existing timer keeps the original entered_at: dwell measures
	// how long the user has been there, not when we last noticed.
	_, err := s.pool.Exec(ctx, `
		INSERT INTO pending_dwells (device_id, place_id, user_id, entered_at, fire_at)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (device_id, place_id) DO UPDATE SET fire_at = EXCLUDED.fire_at`,
		d.DeviceID, d.PlaceID, d.UserID, d.EnteredAt.UTC(), d.FireAt.UTC())
	err = mapError("put pending dwell", err)
	observe("PutPendingDwell", start, err)
	return err
}

func (s *Store) DeletePendingDwell(ctx context.Context, deviceID, placeID string) error {
	start := time.Now()
	_, err := s.pool.Exec(ctx,
		`DELETE FROM pending_dwells WHERE device_id = $1 AND place_id = $2`, deviceID, placeID)
	err = mapError("delete pending dwell", err)
	observe("DeletePendingDwell", start, err)
	return err
}

func (s *Store) DuePendingDwells(ctx context.Context, at time.Time) ([]domain.PendingDwell, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT device_id, place_id, user_id, entered_at, fire_at
		FROM pending_dwells
		WHERE fire_at <= $1
		ORDER BY fire_at`, at.UTC())
	if err != nil {
		observe("DuePendingDwells", start, err)
		return nil, mapError("due pending dwells", err)
	}
	defer rows.Close()
	return scanDwells(rows, start)
}

func (s *Store) ListPendingDwells(ctx context.Context, userID string) ([]domain.PendingDwell, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx, `
		SELECT device_id, place_id, user_id, entered_at, fire_at
		FROM pending_dwells
		WHERE user_id = $1
		ORDER BY fire_at`, userID)
	if err != nil {
		observe("ListPendingDwells", start, err)
		return nil, mapError("list pending dwells", err)
	}
	defer rows.Close()
	return scanDwells(rows, start)
}

func scanDwells(rows pgx.Rows, start time.Time) ([]domain.PendingDwell, error) {
	out := []domain.PendingDwell{}
	for rows.Next() {
		var d domain.PendingDwell
		if err := rows.Scan(&d.DeviceID, &d.PlaceID, &d.UserID, &d.EnteredAt, &d.FireAt); err != nil {
			observe("scanDwells", start, err)
			return nil, mapError("scan pending dwell", err)
		}
		out = append(out, d)
	}
	err := rows.Err()
	observe("scanDwells", start, err)
	return out, mapError("pending dwells", err)
}

// ---------------------------------------------------------------- connections

const connectionCols = `id, user_id, peer_id, peer_name, peer_email, status, sharing, created_at, updated_at`

func scanConnection(row pgx.Row) (domain.Connection, error) {
	var (
		c      domain.Connection
		status string
	)
	err := row.Scan(&c.ID, &c.UserID, &c.PeerID, &c.PeerName, &c.PeerEmail,
		&status, &c.Sharing, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return domain.Connection{}, err
	}
	c.Status = domain.ConnectionStatus(status)
	return c, nil
}

func (s *Store) ListConnections(ctx context.Context, userID string) ([]domain.Connection, error) {
	start := time.Now()
	// Pending rows first: those are the ones waiting on a decision.
	rows, err := s.pool.Query(ctx, `
		SELECT `+connectionCols+`
		FROM connections
		WHERE user_id = $1
		ORDER BY (status = 'accepted'), created_at, peer_id`, userID)
	if err != nil {
		observe("ListConnections", start, err)
		return nil, mapError("list connections", err)
	}
	defer rows.Close()

	out := []domain.Connection{}
	for rows.Next() {
		c, err := scanConnection(rows)
		if err != nil {
			observe("ListConnections", start, err)
			return nil, mapError("scan connection", err)
		}
		out = append(out, c)
	}
	err = rows.Err()
	observe("ListConnections", start, err)
	return out, mapError("list connections", err)
}

func (s *Store) GetConnection(ctx context.Context, userID, peerID string) (domain.Connection, error) {
	start := time.Now()
	c, err := scanConnection(s.pool.QueryRow(ctx,
		`SELECT `+connectionCols+` FROM connections WHERE user_id = $1 AND peer_id = $2`, userID, peerID))
	err = mapError("connection "+userID+"→"+peerID, err)
	observe("GetConnection", start, err)
	return c, err
}

// UpsertConnection writes one side of a relationship. The conflict target is
// (user_id, peer_id): re-inviting or re-accepting updates the existing row
// rather than creating a second one, and created_at is preserved so the People
// list keeps a stable order.
func (s *Store) UpsertConnection(ctx context.Context, c domain.Connection) (domain.Connection, error) {
	start := time.Now()
	if c.UserID == "" || c.PeerID == "" {
		return domain.Connection{}, fmt.Errorf("connection needs both sides: %w", domain.ErrInvalid)
	}
	if c.UserID == c.PeerID {
		return domain.Connection{}, fmt.Errorf("cannot connect a user to themselves: %w", domain.ErrInvalid)
	}
	if c.ID == "" {
		c.ID = idgen.New("con")
	}
	if c.CreatedAt.IsZero() {
		c.CreatedAt = time.Now().UTC()
	}

	out, err := scanConnection(s.pool.QueryRow(ctx, `
		INSERT INTO connections (id, user_id, peer_id, peer_name, peer_email, status, sharing, created_at, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
		ON CONFLICT (user_id, peer_id) DO UPDATE SET
			peer_name  = EXCLUDED.peer_name,
			peer_email = EXCLUDED.peer_email,
			status     = EXCLUDED.status,
			sharing    = EXCLUDED.sharing,
			updated_at = now()
		RETURNING `+connectionCols,
		c.ID, c.UserID, c.PeerID, c.PeerName, c.PeerEmail, string(c.Status), c.Sharing, c.CreatedAt))
	err = mapError("upsert connection", err)
	observe("UpsertConnection", start, err)
	return out, err
}

func (s *Store) DeleteConnection(ctx context.Context, userID, peerID string) error {
	start := time.Now()
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM connections WHERE user_id = $1 AND peer_id = $2`, userID, peerID)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("connection %s→%s: %w", userID, peerID, domain.ErrNotFound)
	}
	err = mapError("delete connection", err)
	observe("DeleteConnection", start, err)
	return err
}
