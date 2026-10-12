-- 0003_polygons_peers — drawn geofences, and notes for and about other people.
--
-- Polygons are additive, exactly as 0001 promised: `center` and `radius_m` stay
-- NOT NULL and, for a polygon, hold the server-computed centroid and bounding
-- radius. That keeps every existing query (listing, the places grid, the map's
-- "fit to fence") working unchanged, and gives PlacesContaining a cheap circle
-- to reason about. Containment itself uses the ring: ST_Covers, so a fix exactly
-- on the edge counts as inside, matching the in-memory ray cast.

ALTER TABLE places
    ADD COLUMN IF NOT EXISTS shape text NOT NULL DEFAULT 'circle',
    ADD COLUMN IF NOT EXISTS boundary geography(Polygon, 4326),
    -- Connected people whose crossings of this fence notify the owner. Their own
    -- sharing switch still decides whether a crossing is evaluated at all.
    ADD COLUMN IF NOT EXISTS watch_user_ids text[] NOT NULL DEFAULT '{}';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'places_shape_check' AND conrelid = 'places'::regclass) THEN
        ALTER TABLE places ADD CONSTRAINT places_shape_check
            CHECK ((shape = 'circle' AND boundary IS NULL) OR (shape = 'polygon' AND boundary IS NOT NULL));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS places_boundary_gix ON places USING gist (boundary);

ALTER TABLE notes
    -- '' = the owner's own devices fire the note; otherwise a peer's do.
    ADD COLUMN IF NOT EXISTS watch_user_id text NOT NULL DEFAULT '',
    -- Who receives the reminder; '{}' means the owner.
    ADD COLUMN IF NOT EXISTS notify_user_ids text[] NOT NULL DEFAULT '{}';

-- The geofence engine asks "which of W's open notes watch U?" for every fix U
-- sends while sharing with W.
CREATE INDEX IF NOT EXISTS notes_watch_idx ON notes (user_id, watch_user_id)
    WHERE NOT done AND watch_user_id <> '';
