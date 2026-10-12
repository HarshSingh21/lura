/**
 * Pure geometry for the geofence editor.
 *
 * This file has no imports on purpose: scripts/test-geometry.mjs transpiles it
 * on its own and runs assertions against it under plain Node, so it must not
 * pull in React Native, the theme or path aliases. The types are structural
 * copies of `Point` from the API types, which keeps them interchangeable.
 *
 * Two coordinate spaces appear here and the distinction matters:
 *
 *   - `LatLon` is a coordinate on the ground. Distances on it are haversine
 *     metres; shape tests (crossing edges, containment) treat lon/lat as a plane,
 *     which is exact enough at the scale of a geofence (a few kilometres).
 *   - `XY` is a screen pixel. Simplifying a freehand sketch and hit-testing a
 *     fence body happen here, because "close enough" is a question about what
 *     the finger did, not about metres.
 */

export type LatLon = { lat: number; lon: number };
export type XY = { x: number; y: number };

/** The limits the server enforces on a fence (internal/httpapi validatePlace). */
export const MIN_RADIUS_M = 25;
export const MAX_RADIUS_M = 5000;
export const MAX_POLYGON_VERTICES = 200;
/** A freehand sketch is simplified to at most this many corners. */
export const MAX_FREEHAND_VERTICES = 60;

const EARTH_RADIUS_M = 6_371_008.8;

/** haversineM is the great-circle distance between two coordinates in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** clampRadius keeps a dragged radius inside what the server accepts, in whole metres. */
export function clampRadius(radiusM: number): number {
  if (!Number.isFinite(radiusM)) return MIN_RADIUS_M;
  return Math.round(Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, radiusM)));
}

// ---------------------------------------------------------------- polygons on the ground

function toXY(p: LatLon): XY {
  return { x: p.lon, y: p.lat };
}

/**
 * polygonCentroid is the area-weighted centroid of a ring (not closed).
 *
 * The vertex average is the wrong answer for a fence: a polygon traced with many
 * points along one side would have its "centre" dragged towards that side. A
 * degenerate ring (zero area, e.g. every point on a line) falls back to the
 * vertex average rather than dividing by zero.
 */
export function polygonCentroid(ring: LatLon[]): LatLon {
  const n = ring.length;
  if (n === 0) return { lat: 0, lon: 0 };
  // Work relative to the first vertex: it keeps the cross products small, which
  // matters when the coordinates are large and the polygon is tiny.
  const origin = ring[0];
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const ax = a.lon - origin.lon;
    const ay = a.lat - origin.lat;
    const bx = b.lon - origin.lon;
    const by = b.lat - origin.lat;
    const cross = ax * by - bx * ay;
    area2 += cross;
    cx += (ax + bx) * cross;
    cy += (ay + by) * cross;
  }
  if (Math.abs(area2) < 1e-18) {
    const lat = ring.reduce((s, p) => s + p.lat, 0) / n;
    const lon = ring.reduce((s, p) => s + p.lon, 0) / n;
    return { lat, lon };
  }
  return { lat: origin.lat + cy / (3 * area2), lon: origin.lon + cx / (3 * area2) };
}

/** boundingRadiusM is the farthest vertex from the centroid, as the server computes it. */
export function boundingRadiusM(ring: LatLon[], centre: LatLon = polygonCentroid(ring)): number {
  let max = 0;
  for (const p of ring) max = Math.max(max, haversineM(centre, p));
  return Math.ceil(max);
}

/** polygonSelfIntersects reports whether a ring (not closed) has crossing or touching edges. */
export function polygonSelfIntersects(ring: LatLon[]): boolean {
  return ringSelfIntersectsXY(ring.map(toXY));
}

/** pathSelfIntersects is the open-polyline version, used while a polygon is still being drawn. */
export function pathSelfIntersects(path: LatLon[]): boolean {
  return pathSelfIntersectsXY(path.map(toXY));
}

/** pointInPolygon is even-odd ray casting; a point exactly on an edge may land either way. */
export function pointInPolygon(point: LatLon, ring: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > point.lat !== b.lat > point.lat) {
      const lonAt = ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon;
      if (point.lon < lonAt) inside = !inside;
    }
  }
  return inside;
}

/** translatePolygon shifts every vertex by the same offset in degrees. */
export function translatePolygon(ring: LatLon[], dLat: number, dLon: number): LatLon[] {
  return ring.map((p) => ({ lat: p.lat + dLat, lon: p.lon + dLon }));
}

/** insertVertex returns a copy of the ring with `point` placed after index `after`. */
export function insertVertex<T>(ring: T[], after: number, point: T): T[] {
  const next = ring.slice();
  next.splice(after + 1, 0, point);
  return next;
}

/** removeVertex drops one vertex, refusing to take a ring below a triangle. */
export function removeVertex<T>(ring: T[], index: number): T[] {
  if (ring.length <= 3 || index < 0 || index >= ring.length) return ring;
  return ring.filter((_, i) => i !== index);
}

/** midpoint is the plain average of two coordinates (fine for one fence edge). */
export function midpoint(a: LatLon, b: LatLon): LatLon {
  return { lat: (a.lat + b.lat) / 2, lon: (a.lon + b.lon) / 2 };
}

/**
 * validatePolygon returns why a ring cannot be saved, or null when it can.
 *
 * These are the same rules the server applies (3–200 vertices, no crossing
 * edges, and a size the geofence engine accepts), checked here so the editor
 * can say so while the finger is still on the glass instead of after a 400.
 */
export function validatePolygon(ring: LatLon[]): string | null {
  if (ring.length < 3) return 'A shape needs at least three corners';
  if (ring.length > MAX_POLYGON_VERTICES) return `A shape can have at most ${MAX_POLYGON_VERTICES} corners`;
  if (polygonSelfIntersects(ring)) return 'Edges cannot cross each other';
  const r = boundingRadiusM(ring);
  if (r < MIN_RADIUS_M) return 'That shape is too small to be a geofence';
  if (r > MAX_RADIUS_M) return 'That shape is too large (5 km at most)';
  return null;
}

// ---------------------------------------------------------------- screen space

/** orientation is the sign of the cross product: >0 counter-clockwise, <0 clockwise, 0 collinear. */
function orientation(a: XY, b: XY, c: XY): number {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  // A relative epsilon: lat/lon deltas are tiny, pixel deltas are not.
  const scale = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y), Math.abs(c.x - a.x), Math.abs(c.y - a.y));
  if (Math.abs(v) <= 1e-12 * scale * scale) return 0;
  return v > 0 ? 1 : -1;
}

function onSegment(a: XY, b: XY, p: XY): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** segmentsIntersect is true when segments ab and cd share any point (touching counts). */
export function segmentsIntersect(a: XY, b: XY, c: XY, d: XY): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/**
 * adjacentFolds reports whether two edges sharing vertex `b` (a→b, b→c) double
 * back over each other — a spike, which is a self-intersection even though the
 * edges only "touch" at their shared vertex.
 */
function adjacentFolds(a: XY, b: XY, c: XY): boolean {
  if (orientation(a, b, c) !== 0) return false;
  // Collinear: it folds when c lies back towards a, i.e. the turn is 180°.
  const dot = (a.x - b.x) * (c.x - b.x) + (a.y - b.y) * (c.y - b.y);
  return dot > 0;
}

function samePoint(a: XY, b: XY): boolean {
  return a.x === b.x && a.y === b.y;
}

/** ringSelfIntersectsXY checks a closed ring (the last vertex connects back to the first). */
export function ringSelfIntersectsXY(ring: XY[]): boolean {
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    if (samePoint(ring[i], ring[(i + 1) % n])) return true; // a zero-length edge
  }
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (adjacentFolds(a, b, ring[(i + 2) % n])) return true;
    for (let j = i + 2; j < n; j += 1) {
      // Edge n-1 and edge 0 are neighbours through vertex 0.
      if (i === 0 && j === n - 1) continue;
      if (segmentsIntersect(a, b, ring[j], ring[(j + 1) % n])) return true;
    }
  }
  return false;
}

/** pathSelfIntersectsXY checks an open polyline (no closing edge). */
export function pathSelfIntersectsXY(path: XY[]): boolean {
  const n = path.length;
  for (let i = 0; i + 1 < n; i += 1) {
    if (samePoint(path[i], path[i + 1])) return true;
    if (i + 2 < n && adjacentFolds(path[i], path[i + 1], path[i + 2])) return true;
    for (let j = i + 2; j + 1 < n; j += 1) {
      if (segmentsIntersect(path[i], path[i + 1], path[j], path[j + 1])) return true;
    }
  }
  return false;
}

/** perpendicularDistance is the distance from p to the segment ab. */
function segmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** simplifyPath is Douglas–Peucker on an open polyline; the end points are always kept. */
export function simplifyPath(points: XY[], tolerance: number): XY[] {
  if (points.length <= 2) return points.slice();
  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  // An explicit stack instead of recursion: a long sketch must not blow it.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let index = -1;
    for (let i = start + 1; i < end; i += 1) {
      const d = segmentDistance(points[i], points[start], points[end]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > tolerance) {
      keep[index] = true;
      stack.push([start, index], [index, end]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * simplifyRing turns a freehand sketch into a fence outline of at most
 * `maxVertices` corners.
 *
 * A ring has no natural end points, so it is split at the first point and the
 * point farthest from it — the two that are certainly corners — and each half is
 * simplified as a path. The tolerance starts at `tolerance` pixels and grows
 * until the corner budget is met, so a careful sketch keeps its detail and a
 * scribble is not punished with 400 vertices.
 *
 * Returns fewer than three points only when the sketch has no area to speak of;
 * the caller treats that as "not a shape".
 */
export function simplifyRing(points: XY[], maxVertices = MAX_FREEHAND_VERTICES, tolerance = 2): XY[] {
  // Drop consecutive duplicates and a closing point equal to the first.
  const clean: XY[] = [];
  for (const p of points) {
    const last = clean[clean.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) clean.push(p);
  }
  while (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 0.5) {
    clean.pop();
  }
  if (clean.length <= 3) return clean;

  let far = 0;
  let farDist = -1;
  for (let i = 1; i < clean.length; i += 1) {
    const d = Math.hypot(clean[i].x - clean[0].x, clean[i].y - clean[0].y);
    if (d > farDist) {
      farDist = d;
      far = i;
    }
  }

  const budget = Math.max(3, maxVertices);
  let tol = Math.max(0.1, tolerance);
  let result = clean;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const first = simplifyPath(clean.slice(0, far + 1), tol);
    const second = simplifyPath([...clean.slice(far), clean[0]], tol);
    // Both halves include the split points; drop the duplicates when joining.
    result = [...first, ...second.slice(1, -1)];
    if (result.length <= budget) break;
    tol *= 1.4;
  }
  if (result.length > budget) result = result.slice(0, budget);
  return result;
}

/** A horizontal strip of a filled shape, used as a touch target for its body. */
export type Span = { y: number; height: number; x0: number; x1: number };

/**
 * scanlineSpans fills a ring with horizontal strips of `rowHeight` pixels.
 *
 * React Native has no hit-testing for arbitrary shapes, and an overlay that
 * covers the map to hit-test by hand would stop the map from panning anywhere.
 * Rendering the fence body as a stack of thin invisible strips — each one exactly
 * as wide as the shape at its height — gives a touch target that follows a
 * concave polygon on every platform and leaves the rest of the map alone.
 * Strips are clipped to [0, height] so a fence larger than the screen does not
 * cost one view per off-screen row.
 */
export function scanlineSpans(ring: XY[], rowHeight: number, viewHeight: number, viewWidth = Infinity): Span[] {
  const n = ring.length;
  if (n < 3 || rowHeight <= 0) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const top = Math.max(0, minY);
  const bottom = Math.min(viewHeight, maxY);
  const spans: Span[] = [];
  for (let y0 = top; y0 < bottom; y0 += rowHeight) {
    const h = Math.min(rowHeight, bottom - y0);
    const y = y0 + h / 2;
    const xs: number[] = [];
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const a = ring[i];
      const b = ring[j];
      if (a.y > y !== b.y > y) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, xs[k]);
      const x1 = Math.min(viewWidth, xs[k + 1]);
      if (x1 - x0 >= 1) spans.push({ y: y0, height: h, x0, x1 });
    }
  }
  return spans;
}

/** circleRingXY approximates a screen-space circle as a ring, for spans and hit tests. */
export function circleRingXY(centre: XY, radiusPx: number, steps = 48): XY[] {
  const ring: XY[] = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push({ x: centre.x + radiusPx * Math.cos(a), y: centre.y + radiusPx * Math.sin(a) });
  }
  return ring;
}

/** distanceXY is the pixel distance between two screen points. */
export function distanceXY(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** formatMetres renders a fence size the way the map labels it ("85 m", "1.2 km"). */
export function formatMetres(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}
