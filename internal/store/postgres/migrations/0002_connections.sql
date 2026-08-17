-- 0002_connections — mutual live-location sharing between accounts (HLD §2.1).
--
-- One row per direction, each owned by its user_id. That shape is the consent
-- model: my row says what I share and what I have agreed to; their row says the
-- same for them. Neither side can edit the other's row, and either side can stop
-- sharing without deleting the relationship.
--
-- This is deliberately separate from `shares`: a share is a link for someone who
-- may have no account and is one-way; a connection is two accounts agreeing to
-- see each other.

CREATE TABLE IF NOT EXISTS connections (
    id         text PRIMARY KEY,
    user_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    peer_id    text        NOT NULL REFERENCES users (id) ON DELETE CASCADE,

    -- Cached so the People list renders without a join per row. Refreshed
    -- whenever the relationship is written.
    peer_name  text        NOT NULL DEFAULT '',
    peer_email text        NOT NULL DEFAULT '',

    status     text        NOT NULL CHECK (status IN ('pending_out', 'pending_in', 'accepted')),

    -- This side's own switch: whether this user's position is visible to the
    -- peer. The peer has an independent one in their own row.
    sharing    boolean     NOT NULL DEFAULT true,

    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    -- One relationship per direction, and nobody connects to themselves.
    UNIQUE (user_id, peer_id),
    CHECK (user_id <> peer_id)
);

CREATE INDEX IF NOT EXISTS connections_user_idx ON connections (user_id);
-- The Gateway asks "whose positions may this user subscribe to?" on every
-- connect and on every ACL change, so the accepted+sharing lookup is hot.
CREATE INDEX IF NOT EXISTS connections_live_idx ON connections (peer_id, user_id)
    WHERE status = 'accepted' AND sharing;

-- Email is how people invite each other, so it has to be findable and unique.
-- Existing rows may share a blank email, so the index skips those.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE email <> '';
