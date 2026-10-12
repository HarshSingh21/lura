package geo

import (
	"errors"
	"math"
)

// Vertex is one corner of a polygon ring. It has the same shape as
// domain.Point, so a []domain.Point converts element-wise without this package
// depending on the domain.
type Vertex struct {
	Lat, Lon float64
}

// Polygon limits. Three vertices is the smallest ring that encloses anything;
// 200 is far more than a hand-drawn fence needs, and bounds the O(n²)
// self-intersection check and the per-fix ray cast.
const (
	MinPolygonVertices = 3
	MaxPolygonVertices = 200
)

// Polygon validation errors. The API layer maps every one of them to
// 400 invalid_polygon; the distinct messages are for the person who drew it.
var (
	ErrPolygonTooFew       = errors.New("polygon needs at least 3 vertices")
	ErrPolygonTooMany      = errors.New("polygon has more than 200 vertices")
	ErrPolygonBadVertex    = errors.New("polygon vertex is not a valid lat/lon")
	ErrPolygonDuplicate    = errors.New("polygon has repeated consecutive vertices")
	ErrPolygonSelfCrossing = errors.New("polygon edges cross each other")
	ErrPolygonNoArea       = errors.New("polygon encloses no area")
)

// OpenRing drops a closing vertex (last == first) if the caller sent one. The
// wire contract is an open ring, but a closed one is an unambiguous spelling of
// the same shape and rejecting it would only punish a well-meaning client.
func OpenRing(ring []Vertex) []Vertex {
	if n := len(ring); n > 1 && ring[0] == ring[n-1] {
		return ring[:n-1]
	}
	return ring
}

// ValidatePolygon checks an open ring: vertex count, coordinates, no
// zero-length edges, non-zero area and no self-intersection.
//
// The geometry is treated as planar on (lon, lat). At city scale — which is
// what a geofence is — the difference from PostGIS' great-circle edges is well
// under GPS noise, and it keeps the memory store and the validator in exact
// agreement with each other.
func ValidatePolygon(ring []Vertex) error {
	n := len(ring)
	if n < MinPolygonVertices {
		return ErrPolygonTooFew
	}
	if n > MaxPolygonVertices {
		return ErrPolygonTooMany
	}
	for i, v := range ring {
		if !Valid(v.Lat, v.Lon) {
			return ErrPolygonBadVertex
		}
		if v == ring[(i+1)%n] {
			return ErrPolygonDuplicate
		}
	}
	// Every pair of edges that do not share a vertex must not touch at all.
	// Adjacent edges share one endpoint by construction, so for them the only
	// failure is a "spike": an edge folding back over its neighbour.
	for i := 0; i < n; i++ {
		a1, a2 := ring[i], ring[(i+1)%n]
		for j := i + 1; j < n; j++ {
			if j == i+1 || (i == 0 && j == n-1) {
				if collinearOverlap(a1, a2, ring[j], ring[(j+1)%n]) {
					return ErrPolygonSelfCrossing
				}
				continue
			}
			if segmentsTouch(a1, a2, ring[j], ring[(j+1)%n]) {
				return ErrPolygonSelfCrossing
			}
		}
	}
	// Checked after crossings: a symmetric bow tie has zero signed area, and
	// "edges cross" is the message that tells its author what went wrong.
	if math.Abs(signedArea(ring)) < 1e-14 {
		return ErrPolygonNoArea
	}
	return nil
}

// PointInPolygon reports whether (lat, lon) lies inside or on the ring, using
// the even-odd ray cast. Points exactly on an edge count as inside, matching
// ST_Covers (as opposed to ST_Contains, which excludes the boundary).
func PointInPolygon(lat, lon float64, ring []Vertex) bool {
	n := len(ring)
	if n < MinPolygonVertices {
		return false
	}
	p := Vertex{lat, lon}
	inside := false
	for i, j := 0, n-1; i < n; j, i = i, i+1 {
		a, b := ring[j], ring[i]
		if onSegment(a, b, p) {
			return true
		}
		if (b.Lat > lat) != (a.Lat > lat) {
			x := (a.Lon-b.Lon)*(lat-b.Lat)/(a.Lat-b.Lat) + b.Lon
			if lon < x {
				inside = !inside
			}
		}
	}
	return inside
}

// Centroid returns the area-weighted centroid of the ring, falling back to the
// vertex mean for a degenerate ring. Longitudes are scaled by cos(lat) around
// the first vertex so the result is the centroid on the ground, not in degree
// space (which is stretched east-west away from the equator).
func Centroid(ring []Vertex) Vertex {
	n := len(ring)
	if n == 0 {
		return Vertex{}
	}
	ref := ring[0]
	k := math.Cos(rad(ref.Lat))
	if k < 1e-9 {
		k = 1e-9
	}
	var a, cx, cy float64
	for i := 0; i < n; i++ {
		x0, y0 := (ring[i].Lon-ref.Lon)*k, ring[i].Lat-ref.Lat
		x1, y1 := (ring[(i+1)%n].Lon-ref.Lon)*k, ring[(i+1)%n].Lat-ref.Lat
		cross := x0*y1 - x1*y0
		a += cross
		cx += (x0 + x1) * cross
		cy += (y0 + y1) * cross
	}
	if math.Abs(a) < 1e-18 {
		var lat, lon float64
		for _, v := range ring {
			lat += v.Lat
			lon += v.Lon
		}
		return Vertex{lat / float64(n), lon / float64(n)}
	}
	a /= 2
	return Vertex{
		Lat: ref.Lat + cy/(6*a),
		Lon: ref.Lon + cx/(6*a)/k,
	}
}

// BoundingRadiusM is the largest distance from c to any vertex, rounded up to
// a whole metre. A circle of this radius around c covers the whole polygon, so
// the bbox pre-filter and the map's "fit to fence" both keep working.
func BoundingRadiusM(c Vertex, ring []Vertex) int {
	var maxD float64
	for _, v := range ring {
		if d := DistanceM(c.Lat, c.Lon, v.Lat, v.Lon); d > maxD {
			maxD = d
		}
	}
	return int(math.Ceil(maxD))
}

// ---------------------------------------------------------------- planar helpers

// signedArea is the shoelace area in degree² space, computed relative to the
// first vertex: with absolute coordinates the products are ~10³ and their
// cancellation error would swamp the area of a small fence.
func signedArea(ring []Vertex) float64 {
	var a float64
	n := len(ring)
	ref := ring[0]
	for i := 0; i < n; i++ {
		p, q := ring[i], ring[(i+1)%n]
		a += (p.Lon-ref.Lon)*(q.Lat-ref.Lat) - (q.Lon-ref.Lon)*(p.Lat-ref.Lat)
	}
	return a / 2
}

// orient is the sign of the cross product (b-a)×(c-a) with x = lon, y = lat.
func orient(a, b, c Vertex) float64 {
	return (b.Lon-a.Lon)*(c.Lat-a.Lat) - (b.Lat-a.Lat)*(c.Lon-a.Lon)
}

func sign(v float64) int {
	const eps = 1e-15
	switch {
	case v > eps:
		return 1
	case v < -eps:
		return -1
	}
	return 0
}

func onSegment(a, b, p Vertex) bool {
	if sign(orient(a, b, p)) != 0 {
		return false
	}
	return p.Lon >= math.Min(a.Lon, b.Lon) && p.Lon <= math.Max(a.Lon, b.Lon) &&
		p.Lat >= math.Min(a.Lat, b.Lat) && p.Lat <= math.Max(a.Lat, b.Lat)
}

// segmentsTouch reports whether segments p1p2 and q1q2 share any point.
func segmentsTouch(p1, p2, q1, q2 Vertex) bool {
	d1 := sign(orient(q1, q2, p1))
	d2 := sign(orient(q1, q2, p2))
	d3 := sign(orient(p1, p2, q1))
	d4 := sign(orient(p1, p2, q2))
	if d1*d2 < 0 && d3*d4 < 0 {
		return true
	}
	return (d1 == 0 && onSegment(q1, q2, p1)) ||
		(d2 == 0 && onSegment(q1, q2, p2)) ||
		(d3 == 0 && onSegment(p1, p2, q1)) ||
		(d4 == 0 && onSegment(p1, p2, q2))
}

// collinearOverlap catches adjacent edges that double back over each other
// (a→b→a'), which share more than their common endpoint.
func collinearOverlap(p1, p2, q1, q2 Vertex) bool {
	if sign(orient(p1, p2, q1)) != 0 || sign(orient(p1, p2, q2)) != 0 {
		return false
	}
	// Collinear: they overlap beyond a single shared endpoint if either segment
	// has an endpoint strictly inside the other.
	strictlyInside := func(a, b, p Vertex) bool { return p != a && p != b && onSegment(a, b, p) }
	return strictlyInside(p1, p2, q1) || strictlyInside(p1, p2, q2) ||
		strictlyInside(q1, q2, p1) || strictlyInside(q1, q2, p2)
}

// ---------------------------------------------------------------- distances and crossings

// local projects v onto a plane tangent at ref, in metres (x east, y north).
// At geofence scale (well under 10 km) the error is centimetres, far below GPS
// noise, and it keeps distance-to-edge a plain 2-D problem.
func local(ref, v Vertex) (x, y float64) {
	k := math.Cos(rad(ref.Lat))
	return rad(v.Lon-ref.Lon) * EarthRadiusM * k, rad(v.Lat-ref.Lat) * EarthRadiusM
}

// closestOnSegment returns the parameter t in [0, 1] of the point on segment
// ab closest to p, all in the plane.
func closestOnSegment(px, py, ax, ay, bx, by float64) float64 {
	dx, dy := bx-ax, by-ay
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return 0
	}
	t := ((px-ax)*dx + (py-ay)*dy) / l2
	return math.Max(0, math.Min(1, t))
}

// SegmentDistanceM is the distance in metres from p to the segment ab.
func SegmentDistanceM(p, a, b Vertex) float64 {
	ax, ay := local(p, a)
	bx, by := local(p, b)
	t := closestOnSegment(0, 0, ax, ay, bx, by)
	return math.Hypot(ax+(bx-ax)*t, ay+(by-ay)*t)
}

// ClosestPointOnSegment is the point of segment ab nearest to p.
func ClosestPointOnSegment(p, a, b Vertex) Vertex {
	ax, ay := local(p, a)
	bx, by := local(p, b)
	t := closestOnSegment(0, 0, ax, ay, bx, by)
	return Vertex{Lat: a.Lat + (b.Lat-a.Lat)*t, Lon: a.Lon + (b.Lon-a.Lon)*t}
}

// DistanceToRingM is the distance in metres from p to the nearest edge of the
// ring. It says nothing about which side p is on: callers that need "how far
// outside" check PointInPolygon first.
func DistanceToRingM(p Vertex, ring []Vertex) float64 {
	n := len(ring)
	if n == 0 {
		return math.Inf(1)
	}
	best := math.Inf(1)
	for i := 0; i < n; i++ {
		if d := SegmentDistanceM(p, ring[i], ring[(i+1)%n]); d < best {
			best = d
		}
	}
	return best
}

// SegmentCrossesRing reports whether the segment ab touches any edge of the
// ring — the "cross" of Tile38's fence detection: a path that went through a
// fence between two fixes even though neither fix landed inside it. It uses
// the same planar lon/lat rule as ValidatePolygon and PointInPolygon.
func SegmentCrossesRing(a, b Vertex, ring []Vertex) bool {
	n := len(ring)
	if n < MinPolygonVertices {
		return false
	}
	for i := 0; i < n; i++ {
		if segmentsTouch(a, b, ring[i], ring[(i+1)%n]) {
			return true
		}
	}
	return false
}
