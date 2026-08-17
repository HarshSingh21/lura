// Package postgres is the durable store: PostgreSQL + PostGIS, with TimescaleDB
// used for the positions hypertable when the extension is available.
//
// Two principles run through this package:
//
//   - Spatial work happens in SQL. ST_DWithin over a GIST index answers "which
//     places contain this point" far better than fetching every place and
//     measuring in Go, and it is the same predicate the Phase 2 Tile38 path has
//     to agree with.
//   - Guards are expressed as SQL, not as read-modify-write. The monotonic
//     last_point update and the idempotent position insert are single statements,
//     so they stay correct with many writers and with at-least-once redelivery
//     (HLD §5.3, §10) without a transaction or a lock.
package postgres

import (
	"context"
	"embed"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/HarshSingh21/locnot/internal/domain"
	"github.com/HarshSingh21/locnot/internal/idgen"
	"github.com/HarshSingh21/locnot/internal/metrics"
	"github.com/HarshSingh21/locnot/internal/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// migrationLockID is an arbitrary but fixed advisory-lock key. Two replicas
// booting at once must not race each other through the migrations.
const migrationLockID int64 = 8_242_197_531

// Store is a PostgreSQL-backed store.Store.
type Store struct {
	pool *pgxpool.Pool
	log  *slog.Logger

	// hypertable records whether positions is a TimescaleDB hypertable, which is
	// surfaced on /healthz so an operator can see whether compression and
	// retention policies are available.
	hypertable bool
}

// Open connects and verifies the connection.
func Open(ctx context.Context, dsn string, log *slog.Logger) (*Store, error) {
	if log == nil {
		log = slog.Default()
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse DSN: %w", err)
	}
	// Sized for the Phase 1 single-VM deployment: the ingest path is short-lived
	// statements, so a modest pool with a health check beats a large idle one.
	if cfg.MaxConns < 4 {
		cfg.MaxConns = 10
	}
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.MaxConnLifetime = time.Hour
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return &Store{pool: pool, log: log}, nil
}

// Kind implements store.Store.
func (s *Store) Kind() string {
	if s.hypertable {
		return "postgres+postgis+timescale"
	}
	return "postgres+postgis"
}

// Ping implements store.Store.
func (s *Store) Ping(ctx context.Context) error { return s.pool.Ping(ctx) }

// Close implements store.Store.
func (s *Store) Close() error {
	s.pool.Close()
	return nil
}

// Pool exposes the connection pool for tests and for future read-replica routing.
func (s *Store) Pool() *pgxpool.Pool { return s.pool }

// Migrate applies embedded migrations, then opportunistically upgrades positions
// to a TimescaleDB hypertable.
//
// Timescale is optional on purpose: HLD §17 records that managed Postgres
// services (RDS, Cloud SQL) do not offer it, so Lura must run correctly on plain
// PostGIS and simply gain compression and retention when Timescale is present.
func (s *Store) Migrate(ctx context.Context) error {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration conn: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock($1)`, migrationLockID); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		if _, err := conn.Exec(context.WithoutCancel(ctx), `SELECT pg_advisory_unlock($1)`, migrationLockID); err != nil {
			s.log.Warn("release migration lock failed", "error", err)
		}
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	applied := map[string]bool{}
	rows, err := conn.Query(ctx, `SELECT version FROM schema_migrations`)
	if err != nil {
		return fmt.Errorf("read schema_migrations: %w", err)
	}
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // 0001_, 0002_, … lexical order is intentional

	for _, name := range names {
		if applied[name] {
			continue
		}
		body, err := migrationFS.ReadFile("migrations/" + name)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", name, err)
		}

		// One transaction per migration: a failure leaves the database on the
		// previous version rather than half-way through this one.
		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, string(body)); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.Exec(ctx, `INSERT INTO schema_migrations (version) VALUES ($1)`, name); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record %s: %w", name, err)
		}
		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit %s: %w", name, err)
		}
		s.log.Info("migration applied", "version", name)
	}

	s.enableTimescale(ctx, conn.Conn())
	return nil
}

// enableTimescale converts positions into a hypertable when the extension is
// installed. Failures are logged, never fatal.
func (s *Store) enableTimescale(ctx context.Context, conn *pgx.Conn) {
	var present bool
	if err := conn.QueryRow(ctx,
		`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb')`).Scan(&present); err != nil || !present {
		s.log.Info("timescaledb not installed: positions stays a plain table (compression and retention policies unavailable)")
		return
	}

	var isHyper bool
	if err := conn.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM timescaledb_information.hypertables
			WHERE hypertable_name = 'positions'
		)`).Scan(&isHyper); err != nil {
		s.log.Warn("timescaledb: hypertable check failed", "error", err)
		return
	}
	if isHyper {
		s.hypertable = true
		return
	}

	// migrate_data lets this run on a table that already holds rows, which is the
	// case when Timescale is installed after Lura has been running.
	if _, err := conn.Exec(ctx, `
		SELECT create_hypertable('positions', 'recv_ts',
			chunk_time_interval => INTERVAL '1 day',
			if_not_exists => TRUE, migrate_data => TRUE)`); err != nil {
		s.log.Warn("timescaledb: create_hypertable failed, continuing on a plain table", "error", err)
		return
	}
	s.hypertable = true
	s.log.Info("timescaledb: positions is now a hypertable", "chunkInterval", "1 day")
}

// ---------------------------------------------------------------- helpers

// pointSQL is the canonical way to write a lat/lon pair into a geography column.
// Note the argument order: PostGIS takes (x, y) = (lon, lat), which is the
// classic place to introduce a silent bug.
const pointSQL = `ST_SetSRID(ST_MakePoint($%d, $%d), 4326)::geography`

// latLonSQL reads a geography point back as lat, lon.
func latLonSQL(col string) string {
	return fmt.Sprintf("ST_Y(%s::geometry), ST_X(%s::geometry)", col, col)
}

// observe records store latency and error counts for the golden signals.
func observe(op string, start time.Time, err error) {
	metrics.StoreSeconds.ObserveSince(start, metrics.AttrOp.String(op))
	if err != nil && !errors.Is(err, domain.ErrNotFound) {
		metrics.StoreErrors.Inc(metrics.AttrOp.String(op))
	}
}

// mapError turns driver errors into domain errors so the API layer keeps its
// single error-to-status mapping.
func mapError(what string, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("%s: %w", what, domain.ErrNotFound)
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23505": // unique_violation
			return fmt.Errorf("%s: %w", what, domain.ErrConflict)
		case "23503": // foreign_key_violation
			return fmt.Errorf("%s: referenced row missing: %w", what, domain.ErrInvalid)
		case "23514": // check_violation
			return fmt.Errorf("%s: %s: %w", what, pgErr.ConstraintName, domain.ErrInvalid)
		}
	}
	return fmt.Errorf("%s: %w", what, err)
}

// ---------------------------------------------------------------- users

func (s *Store) GetUser(ctx context.Context, id string) (domain.User, error) {
	start := time.Now()
	var u domain.User
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, display_name, locale, tz, quiet_from, quiet_to, airgap, created_at
		FROM users WHERE id = $1`, id).
		Scan(&u.ID, &u.Email, &u.DisplayName, &u.Locale, &u.TZ, &u.QuietFrom, &u.QuietTo, &u.Airgap, &u.CreatedAt)
	err = mapError("user "+id, err)
	observe("GetUser", start, err)
	return u, err
}

// FindUserByEmail backs invite-by-email. The lookup is case-insensitive because
// people do not type their own address consistently, and the unique index in
// migration 0002 is on lower(email) to match.
func (s *Store) FindUserByEmail(ctx context.Context, email string) (domain.User, error) {
	start := time.Now()
	var u domain.User
	err := s.pool.QueryRow(ctx, `
		SELECT id, email, display_name, locale, tz, quiet_from, quiet_to, airgap, created_at
		FROM users WHERE lower(email) = lower($1) AND email <> ''`, strings.TrimSpace(email)).
		Scan(&u.ID, &u.Email, &u.DisplayName, &u.Locale, &u.TZ, &u.QuietFrom, &u.QuietTo, &u.Airgap, &u.CreatedAt)
	err = mapError("user "+email, err)
	observe("FindUserByEmail", start, err)
	return u, err
}

func (s *Store) UpsertUser(ctx context.Context, u domain.User) error {
	start := time.Now()
	if u.ID == "" {
		return fmt.Errorf("user id required: %w", domain.ErrInvalid)
	}
	if u.CreatedAt.IsZero() {
		u.CreatedAt = time.Now().UTC()
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO users (id, email, display_name, locale, tz, quiet_from, quiet_to, airgap, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
		ON CONFLICT (id) DO UPDATE SET
			email = EXCLUDED.email,
			display_name = EXCLUDED.display_name,
			locale = EXCLUDED.locale,
			tz = EXCLUDED.tz,
			quiet_from = EXCLUDED.quiet_from,
			quiet_to = EXCLUDED.quiet_to,
			airgap = EXCLUDED.airgap`,
		u.ID, u.Email, u.DisplayName, u.Locale, u.TZ, u.QuietFrom, u.QuietTo, u.Airgap, u.CreatedAt)
	err = mapError("upsert user", err)
	observe("UpsertUser", start, err)
	return err
}

// UpdateUserSettings applies fn inside a transaction with the row locked, so two
// concurrent settings saves cannot lose one another's changes.
func (s *Store) UpdateUserSettings(ctx context.Context, id string, fn func(*domain.User)) (domain.User, error) {
	start := time.Now()
	var out domain.User

	err := s.inTx(ctx, func(tx pgx.Tx) error {
		var u domain.User
		if err := tx.QueryRow(ctx, `
			SELECT id, email, display_name, locale, tz, quiet_from, quiet_to, airgap, created_at
			FROM users WHERE id = $1 FOR UPDATE`, id).
			Scan(&u.ID, &u.Email, &u.DisplayName, &u.Locale, &u.TZ, &u.QuietFrom, &u.QuietTo, &u.Airgap, &u.CreatedAt); err != nil {
			return mapError("user "+id, err)
		}
		fn(&u)
		u.ID = id
		if _, err := tx.Exec(ctx, `
			UPDATE users SET email=$2, display_name=$3, locale=$4, tz=$5,
			                 quiet_from=$6, quiet_to=$7, airgap=$8
			WHERE id = $1`,
			u.ID, u.Email, u.DisplayName, u.Locale, u.TZ, u.QuietFrom, u.QuietTo, u.Airgap); err != nil {
			return mapError("update user", err)
		}
		out = u
		return nil
	})
	observe("UpdateUserSettings", start, err)
	return out, err
}

func (s *Store) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback(context.WithoutCancel(ctx))
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------- devices

const deviceCols = `id, user_id, name, kind, token, last_seen,
	ST_Y(last_point::geometry), ST_X(last_point::geometry), speed_mps, battery, created_at`

func scanDevice(row pgx.Row) (domain.Device, error) {
	var (
		d        domain.Device
		lat, lon *float64
	)
	err := row.Scan(&d.ID, &d.UserID, &d.Name, &d.Kind, &d.Token, &d.LastSeen,
		&lat, &lon, &d.SpeedMPS, &d.Battery, &d.CreatedAt)
	if err != nil {
		return domain.Device{}, err
	}
	if lat != nil && lon != nil {
		d.LastPoint = &domain.Point{Lat: *lat, Lon: *lon}
	}
	return d, nil
}

func (s *Store) ListDevices(ctx context.Context, userID string) ([]domain.Device, error) {
	start := time.Now()
	rows, err := s.pool.Query(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE user_id = $1 ORDER BY created_at, id`, userID)
	if err != nil {
		observe("ListDevices", start, err)
		return nil, mapError("list devices", err)
	}
	defer rows.Close()

	out := []domain.Device{}
	for rows.Next() {
		d, err := scanDevice(rows)
		if err != nil {
			observe("ListDevices", start, err)
			return nil, mapError("scan device", err)
		}
		out = append(out, d)
	}
	err = rows.Err()
	observe("ListDevices", start, err)
	return out, mapError("list devices", err)
}

func (s *Store) GetDevice(ctx context.Context, userID, id string) (domain.Device, error) {
	start := time.Now()
	d, err := scanDevice(s.pool.QueryRow(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE id = $1 AND user_id = $2`, id, userID))
	err = mapError("device "+id, err)
	observe("GetDevice", start, err)
	return d, err
}

func (s *Store) DeviceByToken(ctx context.Context, token string) (domain.Device, error) {
	start := time.Now()
	d, err := scanDevice(s.pool.QueryRow(ctx,
		`SELECT `+deviceCols+` FROM devices WHERE token = $1`, token))
	if errors.Is(err, pgx.ErrNoRows) {
		// Unauthorized rather than not-found: the caller supplied a credential,
		// and "no such token" must not leak as a different status than "wrong
		// token".
		err = fmt.Errorf("device token: %w", domain.ErrUnauthorized)
	} else {
		err = mapError("device by token", err)
	}
	observe("DeviceByToken", start, err)
	return d, err
}

func (s *Store) UpsertDevice(ctx context.Context, d domain.Device) error {
	start := time.Now()
	if d.ID == "" || d.UserID == "" {
		return fmt.Errorf("device id and user id required: %w", domain.ErrInvalid)
	}
	if d.Token == "" {
		d.Token = idgen.Token()
	}
	if d.CreatedAt.IsZero() {
		d.CreatedAt = time.Now().UTC()
	}
	// The update deliberately leaves last_seen/last_point alone: a rename must
	// not touch position state, which only the writer's monotonic guard may move.
	_, err := s.pool.Exec(ctx, `
		INSERT INTO devices (id, user_id, name, kind, token, created_at)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (id) DO UPDATE SET
			name = EXCLUDED.name,
			kind = EXCLUDED.kind,
			token = EXCLUDED.token
		WHERE devices.user_id = EXCLUDED.user_id`,
		d.ID, d.UserID, d.Name, d.Kind, d.Token, d.CreatedAt)
	err = mapError("upsert device", err)
	observe("UpsertDevice", start, err)
	return err
}

func (s *Store) DeleteDevice(ctx context.Context, userID, id string) error {
	start := time.Now()
	tag, err := s.pool.Exec(ctx, `DELETE FROM devices WHERE id = $1 AND user_id = $2`, id, userID)
	if err == nil && tag.RowsAffected() == 0 {
		err = fmt.Errorf("device %s: %w", id, domain.ErrNotFound)
	}
	err = mapError("delete device", err)
	observe("DeleteDevice", start, err)
	return err
}

// TouchLastPoint is the monotonic last-position guard from HLD §5.3, expressed as
// one statement: the WHERE clause is the guard, so a late fix from an offline
// replay simply updates zero rows.
func (s *Store) TouchLastPoint(ctx context.Context, deviceID string, p domain.Point, ts time.Time, speedMPS float64, battery int) (bool, error) {
	start := time.Now()
	sql := `
		UPDATE devices
		SET last_point = ` + fmt.Sprintf(pointSQL, 2, 3) + `,
			last_seen  = $4,
			speed_mps  = $5,
			battery    = CASE WHEN $6 > 0 THEN $6 ELSE battery END
		WHERE id = $1 AND (last_seen IS NULL OR $4 > last_seen)`
	tag, err := s.pool.Exec(ctx, sql, deviceID, p.Lon, p.Lat, ts.UTC(), speedMPS, battery)
	if err != nil {
		observe("TouchLastPoint", start, err)
		return false, mapError("touch last point", err)
	}
	observe("TouchLastPoint", start, nil)
	return tag.RowsAffected() == 1, nil
}

// ---------------------------------------------------------------- positions

const positionCols = `device_id, user_id, recv_ts, device_ts,
	ST_Y(point::geometry), ST_X(point::geometry),
	accuracy_m, speed_mps, altitude_m, heading_deg, battery, seq`

func scanPosition(row pgx.Row) (domain.Position, error) {
	var p domain.Position
	err := row.Scan(&p.DeviceID, &p.UserID, &p.RecvTS, &p.DeviceTS,
		&p.Point.Lat, &p.Point.Lon,
		&p.AccuracyM, &p.SpeedMPS, &p.AltitudeM, &p.HeadingD, &p.Battery, &p.Seq)
	return p, err
}

// InsertPositions writes a batch idempotently.
//
// ON CONFLICT DO NOTHING on (device_id, recv_ts) is what makes at-least-once
// redelivery safe (HLD §10): replaying a batch is a no-op rather than a duplicate
// row, and the returned count reflects what was actually new.
func (s *Store) InsertPositions(ctx context.Context, ps []domain.Position) (int, error) {
	if len(ps) == 0 {
		return 0, nil
	}
	start := time.Now()

	batch := &pgx.Batch{}
	for _, p := range ps {
		if p.DeviceID == "" {
			return 0, fmt.Errorf("position device id required: %w", domain.ErrInvalid)
		}
		if p.DeviceTS.IsZero() {
			p.DeviceTS = p.RecvTS
		}
		batch.Queue(`
			INSERT INTO positions (device_id, user_id, recv_ts, device_ts, point,
			                       accuracy_m, speed_mps, altitude_m, heading_deg, battery, seq)
			VALUES ($1,$2,$3,$4, ST_SetSRID(ST_MakePoint($5,$6),4326)::geography, $7,$8,$9,$10,$11,$12)
			ON CONFLICT (device_id, recv_ts) DO NOTHING`,
			p.DeviceID, p.UserID, p.RecvTS.UTC(), p.DeviceTS.UTC(),
			p.Point.Lon, p.Point.Lat,
			p.AccuracyM, p.SpeedMPS, p.AltitudeM, p.HeadingD, p.Battery, p.Seq)
	}

	res := s.pool.SendBatch(ctx, batch)
	written := 0
	var firstErr error
	for range ps {
		tag, err := res.Exec()
		if err != nil && firstErr == nil {
			firstErr = err
		}
		written += int(tag.RowsAffected())
	}
	if err := res.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	observe("InsertPositions", start, firstErr)
	if firstErr != nil {
		return written, mapError("insert positions", firstErr)
	}
	return written, nil
}

func (s *Store) ListPositions(ctx context.Context, userID string, q store.PositionQuery) ([]domain.Position, error) {
	start := time.Now()

	sql := `SELECT ` + positionCols + ` FROM positions WHERE user_id = $1`
	args := []any{userID}
	if q.DeviceID != "" {
		args = append(args, q.DeviceID)
		sql += fmt.Sprintf(" AND device_id = $%d", len(args))
	}
	if !q.From.IsZero() {
		args = append(args, q.From.UTC())
		sql += fmt.Sprintf(" AND recv_ts >= $%d", len(args))
	}
	if !q.To.IsZero() {
		args = append(args, q.To.UTC())
		sql += fmt.Sprintf(" AND recv_ts <= $%d", len(args))
	}
	// Newest-first with a LIMIT keeps the most recent window when a client asks
	// for more than the cap; the slice is reversed below so callers always get
	// chronological order.
	sql += " ORDER BY recv_ts DESC"
	if q.Limit > 0 {
		args = append(args, q.Limit)
		sql += fmt.Sprintf(" LIMIT $%d", len(args))
	}

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		observe("ListPositions", start, err)
		return nil, mapError("list positions", err)
	}
	defer rows.Close()

	out := []domain.Position{}
	for rows.Next() {
		p, err := scanPosition(rows)
		if err != nil {
			observe("ListPositions", start, err)
			return nil, mapError("scan position", err)
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		observe("ListPositions", start, err)
		return nil, mapError("list positions", err)
	}
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	observe("ListPositions", start, nil)
	return out, nil
}

func (s *Store) LatestPosition(ctx context.Context, userID, deviceID string) (domain.Position, error) {
	start := time.Now()
	p, err := scanPosition(s.pool.QueryRow(ctx,
		`SELECT `+positionCols+` FROM positions
		 WHERE user_id = $1 AND device_id = $2
		 ORDER BY recv_ts DESC LIMIT 1`, userID, deviceID))
	err = mapError("latest position", err)
	observe("LatestPosition", start, err)
	return p, err
}

func (s *Store) DeletePositionsBefore(ctx context.Context, userID string, before time.Time) (int, error) {
	start := time.Now()
	tag, err := s.pool.Exec(ctx,
		`DELETE FROM positions WHERE user_id = $1 AND recv_ts < $2`, userID, before.UTC())
	observe("DeletePositionsBefore", start, err)
	if err != nil {
		return 0, mapError("delete positions", err)
	}
	return int(tag.RowsAffected()), nil
}

var _ store.Store = (*Store)(nil)
