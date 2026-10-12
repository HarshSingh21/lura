-- 0004_planar_polygons — judge a drawn fence by the edges the map draws.
--
-- 0003 evaluated polygons with ST_Covers on geography, where every edge is a
-- great-circle arc. The map (and the in-memory store's ray cast) draws an edge
-- as a straight line in lon/lat, so an east-west edge runs along a parallel
-- while its great circle bows towards the pole. A fix exactly on a fence's
-- equator-side edge read as outside, and on an 8 km fence at 60°N the two
-- disagreed by ~2 m. PlacesContaining now evaluates ST_Covers on
-- boundary::geometry (planar in lon/lat), so this swaps the geography index for
-- one on the expression the predicate actually uses. The column stays
-- geography: nothing about what is stored changes, only how it is read.

DROP INDEX IF EXISTS places_boundary_gix;
CREATE INDEX IF NOT EXISTS places_boundary_geom_gix ON places USING gist ((boundary::geometry));
