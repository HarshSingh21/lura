-- 0001_init — Lura Phase 1 schema (HLD §6).
--
-- Design notes that matter when reading this:
--
--   * Geometry is GEOGRAPHY(Point,4326), not GEOMETRY: distances come out in
--     metres without projecting, which is exactly what ST_DWithin needs for
--     geofence radii.
--   * A place is a circle (center + radius_m) in Phase 1. Polygons arrive in
--     Phase 2, which is why the column is a point rather than a polygon today —
--     the migration to add `boundary geography(Polygon,4326)` is additive.
--   * positions' primary key is (device_id, recv_ts): the idempotency key from
--     HLD §5.2. recv_ts is microsecond-resolution server time, so two genuine
--     fixes in the same second do not collide the way OwnTracks' `tst` would.
--   * recv_ts is the ordering/dedupe authority; device_ts is kept as data
--     because a device's own clock cannot be trusted.

CREATE EXTENSION IF NOT EXISTS postgis;

-- ---------------------------------------------------------------- users

CREATE TABLE IF NOT EXISTS users (
    id           text PRIMARY KEY,
    email        text        NOT NULL DEFAULT '',
    display_name text        NOT NULL DEFAULT '',
    locale       text        NOT NULL DEFAULT 'en',
    tz           text        NOT NULL DEFAULT 'UTC',
    quiet_from   text        NOT NULL DEFAULT '',
    quiet_to     text        NOT NULL DEFAULT '',
    airgap       boolean     NOT NULL DEFAULT false,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- devices

CREATE TABLE IF NOT EXISTS devices (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text        NOT NULL,
    kind       text        NOT NULL DEFAULT 'phone',
    -- The ingest credential. Unique so a token maps to exactly one device.
    token      text        NOT NULL UNIQUE,
    last_seen  timestamptz,
    last_point geography(Point, 4326),
    speed_mps  double precision,
    battery    integer,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);
CREATE INDEX IF NOT EXISTS devices_last_point_gix ON devices USING gist (last_point);

-- ---------------------------------------------------------------- positions

CREATE TABLE IF NOT EXISTS positions (
    device_id   text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    recv_ts     timestamptz NOT NULL,
    user_id     text        NOT NULL,
    device_ts   timestamptz NOT NULL,
    point       geography(Point, 4326) NOT NULL,
    accuracy_m  real        NOT NULL DEFAULT 0,
    speed_mps   real        NOT NULL DEFAULT 0,
    altitude_m  real        NOT NULL DEFAULT 0,
    heading_deg real        NOT NULL DEFAULT 0,
    battery     integer     NOT NULL DEFAULT 0,
    seq         bigint      NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, recv_ts)
);

-- History queries are always "this user, this window, newest first".
CREATE INDEX IF NOT EXISTS positions_user_ts_idx ON positions (user_id, recv_ts DESC);
CREATE INDEX IF NOT EXISTS positions_device_ts_idx ON positions (device_id, recv_ts DESC);
-- Spatial index for "was I ever near here" and for place-scoped history search.
CREATE INDEX IF NOT EXISTS positions_point_gix ON positions USING gist (point);

-- ---------------------------------------------------------------- places

CREATE TABLE IF NOT EXISTS places (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name       text        NOT NULL,
    tags       text[]      NOT NULL DEFAULT '{}',
    center     geography(Point, 4326) NOT NULL,
    radius_m   integer     NOT NULL CHECK (radius_m > 0),
    triggers   text[]      NOT NULL DEFAULT '{}',
    dwell_mins integer     NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    -- updated_at is part of the AI Brain's embedding cache key (HLD §5.7), so a
    -- rename or retag can never be answered from a stale embedding.
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS places_user_idx ON places (user_id);
CREATE INDEX IF NOT EXISTS places_center_gix ON places USING gist (center);

-- ---------------------------------------------------------------- notes

CREATE TABLE IF NOT EXISTS notes (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    body       text        NOT NULL,
    place_id   text        REFERENCES places (id) ON DELETE SET NULL,
    trigger    text        NOT NULL,
    tags       text[]      NOT NULL DEFAULT '{}',
    done       boolean     NOT NULL DEFAULT false,
    channel    text        NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    fired_at   timestamptz
);

CREATE INDEX IF NOT EXISTS notes_user_idx ON notes (user_id);
-- The notification worker's hot query: open notes for a place and trigger.
CREATE INDEX IF NOT EXISTS notes_resolve_idx ON notes (user_id, place_id, trigger) WHERE NOT done;

-- ---------------------------------------------------------------- shares

CREATE TABLE IF NOT EXISTS shares (
    id            text PRIMARY KEY,
    user_id       text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token         text        NOT NULL UNIQUE,
    label         text        NOT NULL DEFAULT '',
    mode          text        NOT NULL,
    device_ids    text[]      NOT NULL DEFAULT '{}',
    expires_at    timestamptz,
    arrive_place  text        REFERENCES places (id) ON DELETE SET NULL,
    revoked_at    timestamptz,
    revoke_reason text        NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shares_user_idx ON shares (user_id);
-- Supports the "until I arrive" auto-revoke lookup on every arrive event.
CREATE INDEX IF NOT EXISTS shares_arrive_idx ON shares (user_id, arrive_place) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- channels

CREATE TABLE IF NOT EXISTS channels (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    type       text        NOT NULL,
    config     jsonb       NOT NULL DEFAULT '{}'::jsonb,
    enabled    boolean     NOT NULL DEFAULT true,
    priority   integer     NOT NULL DEFAULT 10,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS channels_user_idx ON channels (user_id, priority);

-- ---------------------------------------------------------------- trigger events

CREATE TABLE IF NOT EXISTS trigger_events (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    place_id   text        REFERENCES places (id) ON DELETE SET NULL,
    place_name text        NOT NULL DEFAULT '',
    device_id  text        NOT NULL DEFAULT '',
    trigger    text        NOT NULL,
    ts         timestamptz NOT NULL DEFAULT now(),
    note_ids   text[]      NOT NULL DEFAULT '{}',
    delivered  text[]      NOT NULL DEFAULT '{}',
    note       text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS trigger_events_user_ts_idx ON trigger_events (user_id, ts DESC);
CREATE INDEX IF NOT EXISTS trigger_events_place_idx ON trigger_events (place_id);

-- ---------------------------------------------------------------- pending dwells

-- Armed dwell timers live in the database, not in a cache. HLD §17 flags
-- cache-only dwell timers as a data-loss risk: a Valkey flush would silently
-- drop pending reminders, so Phase 1 keeps them durable and the engine reloads
-- them after a restart.
CREATE TABLE IF NOT EXISTS pending_dwells (
    device_id  text        NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    place_id   text        NOT NULL REFERENCES places (id) ON DELETE CASCADE,
    user_id    text        NOT NULL,
    entered_at timestamptz NOT NULL,
    fire_at    timestamptz NOT NULL,
    PRIMARY KEY (device_id, place_id)
);

CREATE INDEX IF NOT EXISTS pending_dwells_fire_idx ON pending_dwells (fire_at);
