import type { Point } from '@/api/types';

import {
  MAX_POLYGON_VERTICES,
  clampRadius,
  distanceXY,
  haversineM,
  insertVertex,
  midpoint,
  pathSelfIntersects,
  removeVertex,
  simplifyRing,
  validatePolygon,
  type XY,
} from './geometry';
import { project, unproject, type Viewport } from './projection';
import type { FenceGeometry } from './types';

/**
 * What each FenceEditor gesture does to a fence, without the gestures.
 *
 * FenceEditor.tsx owns the touch handling (PanResponder, hit targets, hints);
 * every decision about the geometry — what a tap adds, what a drag moves, what
 * is refused and why — is here, as plain functions of the viewport and the
 * finger's travel. That keeps the editor's rules testable under `node --test`
 * (fenceOps.clientgeo.test.mts) and identical on every renderer.
 *
 * A drag is described by where it started on screen and how far it went
 * (`Delta`, the shape of PanResponder's gesture state).
 */

/** How far a finger went since it touched down, in pixels. */
export type Delta = { dx: number; dy: number };

/** Movement under this many pixels is a tap, not a drag. */
export const TAP_SLOP = 6;
/** A tap this close to the first corner closes the polygon. */
export const CLOSE_PX = 20;
/** Radius a circle gets when the user taps instead of dragging one out. */
export const DEFAULT_RADIUS_M = 100;

/** A refusal the editor shows as a hint (and snaps back from). */
export type Refusal = { problem: string };

export function moved(d: Delta): boolean {
  return Math.hypot(d.dx, d.dy) > TAP_SLOP;
}

export function plus(a: XY, d: Delta): XY {
  return { x: a.x + d.dx, y: a.y + d.dy };
}

function toGround(p: XY, view: Viewport): Point {
  return unproject(p.x, p.y, view);
}

// ---------------------------------------------------------------- draw a circle

/** circlePreview is the circle under the finger while it drags out a radius (unclamped). */
export function circlePreview(origin: XY, d: Delta, view: Viewport): { center: Point; radiusM: number } {
  const center = toGround(origin, view);
  return { center, radiusM: haversineM(center, toGround(plus(origin, d), view)) };
}

/**
 * drawCircle is the circle a press-drag-release leaves: centred where the
 * finger went down, as wide as it dragged (inside the server's limits). A tap
 * drops a sensible default instead of an unusable 25 m dot.
 */
export function drawCircle(origin: XY, d: Delta, view: Viewport): Extract<FenceGeometry, { shape: 'circle' }> {
  const { center, radiusM } = circlePreview(origin, d, view);
  return { shape: 'circle', center, radiusM: clampRadius(moved(d) ? radiusM : DEFAULT_RADIUS_M) };
}

// ---------------------------------------------------------------- draw a polygon

/**
 * PolygonTap is what one tap does while a polygon is being drawn: add a
 * corner, close the shape (a tap on the first corner), or be refused.
 */
export type PolygonTap = { kind: 'add'; polygon: Point[] } | { kind: 'close'; polygon: Point[] } | ({ kind: 'refuse' } & Refusal);

export function tapPolygon(vertices: Point[], at: XY, view: Viewport): PolygonTap {
  if (vertices.length >= 3 && distanceXY(at, project(vertices[0]!, view)) <= CLOSE_PX) {
    const closed = closePolygon(vertices);
    return 'problem' in closed ? { kind: 'refuse', ...closed } : { kind: 'close', polygon: closed.polygon };
  }
  if (vertices.length >= MAX_POLYGON_VERTICES) {
    return { kind: 'refuse', problem: `A shape can have at most ${MAX_POLYGON_VERTICES} corners` };
  }
  const next = [...vertices, toGround(at, view)];
  if (pathSelfIntersects(next)) return { kind: 'refuse', problem: 'That edge would cross another one' };
  return { kind: 'add', polygon: next };
}

/** closePolygon is "Done" (or a tap on the first corner): the ring, if the server would take it. */
export function closePolygon(vertices: Point[]): { polygon: Point[] } | Refusal {
  const problem = validatePolygon(vertices);
  return problem ? { problem } : { polygon: vertices };
}

/** undoPolygon drops the newest corner; with none there is nothing to undo. */
export function undoPolygon(vertices: Point[]): Point[] {
  return vertices.slice(0, -1);
}

// ---------------------------------------------------------------- draw freehand

/**
 * drawFreehand turns a sketch (screen points, in order) into a fence: the
 * outline simplified to at most MAX_FREEHAND_VERTICES corners, then validated
 * like any polygon.
 */
export function drawFreehand(sketch: XY[], view: Viewport): { polygon: Point[] } | Refusal {
  const ring = simplifyRing(sketch);
  if (ring.length < 3) return { problem: 'Drag out an outline — press, draw around the place, release' };
  const polygon = ring.map((p) => toGround(p, view));
  const problem = validatePolygon(polygon);
  if (problem) return { problem: problem === 'Edges cannot cross each other' ? 'The outline crosses itself — try again' : problem };
  return { polygon };
}

// ---------------------------------------------------------------- edit

/**
 * translateFence moves a whole fence by a drag of its body, in screen space so
 * the shape stays the shape you see (a degree of longitude is not the same
 * width at every latitude).
 */
export function translateFence(from: FenceGeometry, d: Delta, view: Viewport): FenceGeometry {
  const shift = (p: Point) => toGround(plus(project(p, view), d), view);
  if (from.shape === 'circle') return { ...from, center: shift(from.center) };
  return { shape: 'polygon', polygon: from.polygon.map(shift) };
}

/** resizeCircle is a drag of the rim handle (which started at `anchor`): the radius follows the finger. */
export function resizeCircle(
  from: Extract<FenceGeometry, { shape: 'circle' }>,
  anchor: XY,
  d: Delta,
  view: Viewport,
): Extract<FenceGeometry, { shape: 'circle' }> {
  return { ...from, radiusM: clampRadius(haversineM(from.center, toGround(plus(anchor, d), view))) };
}

/** moveCorner is a drag of corner `index` (which started at `anchor`). */
export function moveCorner(ring: Point[], index: number, anchor: XY, d: Delta, view: Viewport): Point[] {
  const next = ring.slice();
  next[index] = toGround(plus(anchor, d), view);
  return next;
}

/**
 * addCorner is the "+" handle on edge `edge` (from corner `edge` to the next):
 * a tap inserts the edge's midpoint, a drag inserts the corner where it went.
 */
export function addCorner(ring: Point[], edge: number, at: XY, d: Delta, view: Viewport): { polygon: Point[] } | Refusal {
  if (ring.length >= MAX_POLYGON_VERTICES) return { problem: `A shape can have at most ${MAX_POLYGON_VERTICES} corners` };
  const point = moved(d) ? toGround(plus(at, d), view) : midpoint(ring[edge]!, ring[(edge + 1) % ring.length]!);
  return { polygon: insertVertex(ring, edge, point) };
}

/** removeCorner is a long-press (or right-click) on a corner; a triangle keeps all three. */
export function removeCorner(ring: Point[], index: number): { polygon: Point[] } | Refusal {
  if (ring.length <= 3) return { problem: 'A shape needs at least three corners' };
  return { polygon: removeVertex(ring, index) };
}

/**
 * EditOutcome is how a finished edit gesture is reported: `done` geometry is
 * the caller's cue to persist (PATCH); otherwise the editor puts back `from`,
 * the fence as it was, and shows `problem` if there is one.
 */
export type EditOutcome = { geometry: FenceGeometry; done: boolean; problem?: string };

/**
 * settleEdit decides how a gesture ends. A cancelled gesture, or one that did
 * nothing (a tap on the body), restores the fence; an invalid shape (crossing
 * edges, too small, too large) is refused and restored, so it is never saved.
 */
export function settleEdit(from: FenceGeometry, next: FenceGeometry | null, cancelled: boolean): EditOutcome {
  if (cancelled || !next) return { geometry: from, done: false };
  if (next.shape === 'polygon') {
    const problem = validatePolygon(next.polygon);
    if (problem) return { geometry: from, done: false, problem };
  }
  return { geometry: next, done: true };
}
