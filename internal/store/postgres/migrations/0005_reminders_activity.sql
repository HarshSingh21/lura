-- 0005_reminders_activity — reminders that wait for an acknowledgement, and the
-- history the activity feed is built from.
--
-- A reminder is stored once per recipient *before* it is published, so a
-- pending one survives reloads, other devices, signing out and a restart. The
-- note owner's id is kept on the row (not a join through notes) because a note
-- can be deleted while its reminders are still on someone's screen.

CREATE TABLE IF NOT EXISTS reminders (
    id              text PRIMARY KEY,
    user_id         text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    owner_id        text        NOT NULL,
    note_ids        text[]      NOT NULL DEFAULT '{}',
    place_id        text        NOT NULL DEFAULT '',
    place_name      text        NOT NULL DEFAULT '',
    trigger         text        NOT NULL DEFAULT '',
    kind            text        NOT NULL DEFAULT 'note',
    title           text        NOT NULL DEFAULT '',
    body            text        NOT NULL DEFAULT '',
    subject_user_id text        NOT NULL DEFAULT '',
    subject_name    text        NOT NULL DEFAULT '',
    from_user_id    text        NOT NULL DEFAULT '',
    from_name       text        NOT NULL DEFAULT '',
    event_id        text        NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    status          text        NOT NULL DEFAULT 'pending',
    acked_at        timestamptz,
    acked_by        text        NOT NULL DEFAULT '',
    CONSTRAINT reminders_status_check CHECK (status IN ('pending', 'acknowledged'))
);

-- The listing the client loads on every sign-in, reload and reconnect.
CREATE INDEX IF NOT EXISTS reminders_user_status_created_idx
    ON reminders (user_id, status, created_at DESC);
-- The activity feed reads acknowledgements by when they happened.
CREATE INDEX IF NOT EXISTS reminders_user_acked_idx
    ON reminders (user_id, acked_at DESC) WHERE acked_at IS NOT NULL;
-- "Has every recipient acknowledged this note?"
CREATE INDEX IF NOT EXISTS reminders_owner_pending_notes_idx
    ON reminders USING gin (note_ids) WHERE status = 'pending';
-- A redelivered geo event must not store a second reminder for the same person.
CREATE UNIQUE INDEX IF NOT EXISTS reminders_user_event_uidx
    ON reminders (user_id, event_id) WHERE event_id <> '';

-- Whose device crossed, so the feed can say "Nishtha passed Grocery".
ALTER TABLE trigger_events
    ADD COLUMN IF NOT EXISTS subject_user_id text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS subject_name    text NOT NULL DEFAULT '';

-- One row per side of each relationship change: invited, accepted, paused,
-- resumed, removed. peer_id has no foreign key on purpose — "removed" must
-- outlive the peer's account.
CREATE TABLE IF NOT EXISTS connection_events (
    id        text PRIMARY KEY,
    user_id   text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    peer_id   text        NOT NULL,
    peer_name text        NOT NULL DEFAULT '',
    action    text        NOT NULL,
    actor_id  text        NOT NULL DEFAULT '',
    ts        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS connection_events_user_ts_idx ON connection_events (user_id, ts DESC);
