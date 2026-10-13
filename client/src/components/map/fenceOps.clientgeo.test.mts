/**
 * The geofence editor's gestures, as the rules FenceEditor.tsx applies them:
 * draw a circle, draw / close / undo a polygon, freehand, move a fence by its
 * body, resize a circle by its rim, reshape, add and remove corners — and that
 * no gesture can leave a shape the server would refuse.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import '../../test/clientgeo.resolve.mts';

import type { Point } from '@/api/types';

import type { FenceGeometry } from './types.ts';

const ops = await import('./fenceOps.ts');
const geo = await import('./geometry.ts');
const proj = await import('./projection.ts');

type Viewport = import('./projection.ts').Viewport;

// A phone-sized map over central Bengaluru at street zoom.
const view: Viewport = { center: { lat: 12.97, lon: 77.59 }, zoom: 16, width: 400, height: 800 };
const mpp = proj.metresPerPixel(view.center.lat, view.zoom);
const ground = (x: number, y: number): Point => proj.unproject(x, y, view);
const screen = (p: Point) => proj.project(p, view);

const close = (actual: number, expected: number, eps: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} expected ${expected} ± ${eps}, got ${actual}`);

/** A 120 × 120 px square (about 140 m a side here), clockwise on screen. */
const squareXY = [
  { x: 140, y: 340 },
  { x: 260, y: 340 },
  { x: 260, y: 460 },
  { x: 140, y: 460 },
];
const square = squareXY.map((p) => ground(p.x, p.y));

// ---------------------------------------------------------------- circle

test('draw circle: press the centre, drag out the radius', () => {
  const c = ops.drawCircle({ x: 200, y: 400 }, { dx: 100, dy: 0 }, view);
  assert.equal(c.shape, 'circle');
  // The centre is where the finger went down...
  close(c.center.lat, ground(200, 400).lat, 1e-12);
  close(c.center.lon, ground(200, 400).lon, 1e-12);
  // ...and the radius is the drag, in metres, whole.
  close(c.radiusM, 100 * mpp, 1, 'radius');
  assert.equal(c.radiusM, Math.round(c.radiusM));
  // Direction does not matter, only distance.
  const diagonal = ops.drawCircle({ x: 200, y: 400 }, { dx: -60, dy: 80 }, view);
  close(diagonal.radiusM, 100 * mpp, 1, 'diagonal radius');
});

test('draw circle: a tap drops 100 m, a tiny drag is held at the server minimum, a huge one at the maximum', () => {
  assert.equal(ops.drawCircle({ x: 200, y: 400 }, { dx: 0, dy: 0 }, view).radiusM, ops.DEFAULT_RADIUS_M);
  // Within the tap slop is still a tap, not a 4 m circle.
  assert.equal(ops.drawCircle({ x: 200, y: 400 }, { dx: 3, dy: 4 }, view).radiusM, 100);
  assert.equal(ops.drawCircle({ x: 200, y: 400 }, { dx: 10, dy: 0 }, view).radiusM, geo.MIN_RADIUS_M);
  const far = { ...view, zoom: 10 };
  assert.equal(ops.drawCircle({ x: 200, y: 400 }, { dx: 0, dy: 390 }, far).radiusM, geo.MAX_RADIUS_M);
});

test('draw circle: the preview while dragging is the same circle, unclamped', () => {
  const p = ops.circlePreview({ x: 200, y: 400 }, { dx: 10, dy: 0 }, view);
  close(p.radiusM, 10 * mpp, 0.1);
  assert.deepEqual(p.center, ground(200, 400));
});

// ---------------------------------------------------------------- polygon

test('draw polygon: each tap adds a corner, a tap on the first corner closes it', () => {
  let vertices: Point[] = [];
  for (const xy of squareXY) {
    const tap = ops.tapPolygon(vertices, xy, view);
    assert.equal(tap.kind, 'add');
    if (tap.kind !== 'add') return;
    vertices = tap.polygon;
  }
  assert.equal(vertices.length, 4);
  // Close enough to the first corner (within 20 px) closes rather than adds.
  const closing = ops.tapPolygon(vertices, { x: 140 + 12, y: 340 + 9 }, view);
  assert.equal(closing.kind, 'close');
  if (closing.kind === 'close') assert.deepEqual(closing.polygon, vertices);
  // Just outside that radius is a fifth corner instead.
  assert.equal(ops.tapPolygon(vertices, { x: 140 - 30, y: 400 }, view).kind, 'add');
});

test('draw polygon: the first corner does not close a shape that has fewer than three', () => {
  const two = [ground(140, 340), ground(260, 340)];
  // A tap on the first corner of a two-corner path is a corner on top of it:
  // a zero-length edge, which the path check refuses.
  const tap = ops.tapPolygon(two, { x: 140, y: 340 }, view);
  assert.equal(tap.kind, 'refuse');
  assert.equal(ops.closePolygon(two).hasOwnProperty('problem'), true);
  assert.deepEqual(ops.closePolygon(two), { problem: 'A shape needs at least three corners' });
});

test('draw polygon: Done closes a valid ring and refuses an invalid one', () => {
  assert.deepEqual(ops.closePolygon(square), { polygon: square });
  // A bow tie: the open path is fine, the closing edge crosses it.
  const bow = [ground(140, 340), ground(260, 340), ground(140, 460), ground(260, 460)];
  assert.equal(geo.pathSelfIntersects(bow), false);
  assert.deepEqual(ops.closePolygon(bow), { problem: 'Edges cannot cross each other' });
  // Tapping the first corner of the bow tie is refused the same way, not saved.
  const tap = ops.tapPolygon(bow, { x: 140, y: 340 }, view);
  assert.deepEqual(tap, { kind: 'refuse', problem: 'Edges cannot cross each other' });
  // Too small for a geofence (a 6 px triangle, about 7 m).
  const tiny = [ground(200, 400), ground(206, 400), ground(203, 405)];
  assert.deepEqual(ops.closePolygon(tiny), { problem: 'That shape is too small to be a geofence' });
});

test('draw polygon: a tap whose edge would cross an earlier one is refused', () => {
  const path = [ground(140, 340), ground(260, 340), ground(260, 460)];
  // From (260,460) to (200,300) crosses the first edge.
  assert.deepEqual(ops.tapPolygon(path, { x: 200, y: 300 }, view), { kind: 'refuse', problem: 'That edge would cross another one' });
  // Doubling straight back along the last edge is a spike, refused too.
  assert.equal(ops.tapPolygon(path, { x: 260, y: 400 }, view).kind, 'refuse');
});

test('draw polygon: the corner limit is the server limit', () => {
  const many = Array.from({ length: geo.MAX_POLYGON_VERTICES }, (_, i) => {
    const a = (i / geo.MAX_POLYGON_VERTICES) * 2 * Math.PI;
    return ground(200 + 150 * Math.cos(a), 400 + 150 * Math.sin(a));
  });
  assert.deepEqual(ops.tapPolygon(many, { x: 30, y: 30 }, view), {
    kind: 'refuse',
    problem: `A shape can have at most ${geo.MAX_POLYGON_VERTICES} corners`,
  });
});

test('draw polygon: undo drops the newest corner, and nothing on an empty path', () => {
  assert.deepEqual(ops.undoPolygon(square), square.slice(0, 3));
  assert.deepEqual(ops.undoPolygon(ops.undoPolygon(square)), square.slice(0, 2));
  assert.deepEqual(ops.undoPolygon([]), []);
  // Undo does not mutate what the caller holds.
  const held = square.slice();
  ops.undoPolygon(held);
  assert.equal(held.length, 4);
});

// ---------------------------------------------------------------- freehand

/** circleSketch is a finger going round once, with a little wobble. */
function circleSketch(n: number, r = 120, wobble = 2): { x: number; y: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * 2 * Math.PI;
    const rr = r + wobble * Math.sin(i * 1.7);
    return { x: 200 + rr * Math.cos(a), y: 400 + rr * Math.sin(a) };
  });
}

test('freehand: a long sketch becomes a valid fence of at most 60 corners that follows it', () => {
  for (const n of [80, 400, 2000]) {
    const drawn = ops.drawFreehand(circleSketch(n), view);
    assert.ok('polygon' in drawn, `n=${n}: ${'problem' in drawn ? drawn.problem : ''}`);
    if (!('polygon' in drawn)) return;
    assert.ok(drawn.polygon.length >= 3 && drawn.polygon.length <= geo.MAX_FREEHAND_VERTICES, `n=${n}: ${drawn.polygon.length} corners`);
    assert.equal(geo.validatePolygon(drawn.polygon), null);
    // Every corner is on the sketch: within a few pixels of the 120 px circle.
    for (const p of drawn.polygon) {
      const s = screen(p);
      close(Math.hypot(s.x - 200, s.y - 400), 120, 4, `n=${n} corner radius`);
    }
    // And the fence is centred where the sketch was.
    const c = screen(geo.polygonCentroid(drawn.polygon));
    close(c.x, 200, 3);
    close(c.y, 400, 3);
  }
});

test('freehand: an outline that crosses itself is refused in the words of a sketch', () => {
  // A figure of eight.
  const eight = Array.from({ length: 300 }, (_, i) => {
    const a = (i / 300) * 2 * Math.PI;
    return { x: 200 + 140 * Math.sin(a), y: 400 + 120 * Math.sin(a) * Math.cos(a) };
  });
  assert.deepEqual(ops.drawFreehand(eight, view), { problem: 'The outline crosses itself — try again' });
});

test('freehand: a dot or a line is not a shape', () => {
  assert.deepEqual(ops.drawFreehand([{ x: 200, y: 400 }], view), {
    problem: 'Drag out an outline — press, draw around the place, release',
  });
  assert.deepEqual(ops.drawFreehand([{ x: 200, y: 400 }, { x: 200.2, y: 400.1 }], view), {
    problem: 'Drag out an outline — press, draw around the place, release',
  });
  // A straight stroke, out and back, has no area: refused, never saved.
  const stroke = [...Array.from({ length: 50 }, (_, i) => ({ x: 100 + i * 4, y: 400 })), ...Array.from({ length: 50 }, (_, i) => ({ x: 300 - i * 4, y: 400 }))];
  assert.ok('problem' in ops.drawFreehand(stroke, view));
});

// ---------------------------------------------------------------- move

test('move: dragging a circle body moves its centre with the finger and keeps its radius', () => {
  const from: FenceGeometry = { shape: 'circle', center: ground(200, 400), radiusM: 150 };
  const next = ops.translateFence(from, { dx: 50, dy: -30 }, view);
  assert.equal(next.shape, 'circle');
  if (next.shape !== 'circle') return;
  const s = screen(next.center);
  close(s.x, 250, 1e-6);
  close(s.y, 370, 1e-6);
  assert.equal(next.radiusM, 150);
});

test('move: dragging a polygon body moves every corner the same on screen, so the shape is unchanged', () => {
  const from: FenceGeometry = { shape: 'polygon', polygon: square };
  const next = ops.translateFence(from, { dx: -70, dy: 120 }, view);
  assert.equal(next.shape, 'polygon');
  if (next.shape !== 'polygon') return;
  assert.equal(next.polygon.length, 4);
  next.polygon.forEach((p, i) => {
    const s = screen(p);
    close(s.x, squareXY[i]!.x - 70, 1e-6);
    close(s.y, squareXY[i]!.y + 120, 1e-6);
  });
  // The same size on the ground (to well under a metre), still valid.
  close(geo.boundingRadiusM(next.polygon), geo.boundingRadiusM(square), 1);
  assert.equal(geo.validatePolygon(next.polygon), null);
  // And moving back restores it.
  const back = ops.translateFence(next, { dx: 70, dy: -120 }, view);
  if (back.shape === 'polygon') back.polygon.forEach((p, i) => {
    close(p.lat, square[i]!.lat, 1e-9);
    close(p.lon, square[i]!.lon, 1e-9);
  });
});

test('move: a body drag is the caller\'s cue to save; a tap on the body is not', () => {
  const from: FenceGeometry = { shape: 'circle', center: ground(200, 400), radiusM: 150 };
  const g = { dx: 40, dy: 0 };
  assert.equal(ops.moved(g), true);
  const outcome = ops.settleEdit(from, ops.translateFence(from, g, view), false);
  assert.equal(outcome.done, true);
  // A tap (no movement) reaches settleEdit with nothing to apply.
  assert.equal(ops.moved({ dx: 2, dy: 3 }), false);
  assert.deepEqual(ops.settleEdit(from, null, false), { geometry: from, done: false });
});

// ---------------------------------------------------------------- resize

test('resize: dragging the rim handle outwards grows the circle by the drag', () => {
  const from = { shape: 'circle' as const, center: ground(200, 400), radiusM: 116 };
  const rimPx = from.radiusM / mpp;
  const anchor = { x: 200 + rimPx, y: 400 };
  const grown = ops.resizeCircle(from, anchor, { dx: 40, dy: 0 }, view);
  close(grown.radiusM, (rimPx + 40) * mpp, 1);
  assert.deepEqual(grown.center, from.center);
  const shrunk = ops.resizeCircle(from, anchor, { dx: -50, dy: 0 }, view);
  close(shrunk.radiusM, (rimPx - 50) * mpp, 1);
  // Through the centre and out the other side is the distance, held at the minimum near it.
  assert.equal(ops.resizeCircle(from, anchor, { dx: -rimPx, dy: 0 }, view).radiusM, geo.MIN_RADIUS_M);
  // Sideways along the rim keeps the radius (Pythagoras: it grows a little).
  close(ops.resizeCircle(from, anchor, { dx: 0, dy: 30 }, view).radiusM, Math.hypot(rimPx, 30) * mpp, 1);
});

// ---------------------------------------------------------------- reshape

test('reshape: dragging a corner moves that corner only', () => {
  const next = ops.moveCorner(square, 1, squareXY[1]!, { dx: 30, dy: -20 }, view);
  assert.equal(next.length, 4);
  const s = screen(next[1]!);
  close(s.x, 290, 1e-6);
  close(s.y, 320, 1e-6);
  for (const i of [0, 2, 3]) assert.deepEqual(next[i], square[i]);
  // The original ring is untouched (the editor snaps back to it on refusal).
  assert.deepEqual(screen(square[1]!).x.toFixed(6), (260).toFixed(6));
  assert.deepEqual(ops.settleEdit({ shape: 'polygon', polygon: square }, { shape: 'polygon', polygon: next }, false), {
    geometry: { shape: 'polygon', polygon: next },
    done: true,
  });
});

test('reshape: a corner dragged across the shape is refused and the fence snaps back', () => {
  const from: FenceGeometry = { shape: 'polygon', polygon: square };
  // Corner 1 (top right) dragged down past the bottom edge makes a bow tie.
  const crossed = ops.moveCorner(square, 1, squareXY[1]!, { dx: 0, dy: 180 }, view);
  assert.equal(geo.polygonSelfIntersects(crossed), true);
  const outcome = ops.settleEdit(from, { shape: 'polygon', polygon: crossed }, false);
  assert.deepEqual(outcome, { geometry: from, done: false, problem: 'Edges cannot cross each other' });
  // A corner dropped exactly on another is a zero-length edge: refused too.
  const stacked = ops.moveCorner(square, 1, squareXY[1]!, { dx: 0, dy: 120 }, view);
  assert.equal(ops.settleEdit(from, { shape: 'polygon', polygon: stacked }, false).done, false);
});

test('reshape: a cancelled gesture (the OS took the touch) restores the fence', () => {
  const from: FenceGeometry = { shape: 'polygon', polygon: square };
  const next = ops.moveCorner(square, 0, squareXY[0]!, { dx: 10, dy: 10 }, view);
  assert.deepEqual(ops.settleEdit(from, { shape: 'polygon', polygon: next }, true), { geometry: from, done: false });
});

test('add corner: a tap on "+" inserts the edge midpoint, a drag inserts where it went', () => {
  const tapped = ops.addCorner(square, 0, { x: 200, y: 340 }, { dx: 0, dy: 0 }, view);
  assert.ok('polygon' in tapped);
  if (!('polygon' in tapped)) return;
  assert.equal(tapped.polygon.length, 5);
  assert.deepEqual(tapped.polygon[1], geo.midpoint(square[0]!, square[1]!));
  const dragged = ops.addCorner(square, 2, { x: 200, y: 460 }, { dx: 0, dy: 40 }, view);
  assert.ok('polygon' in dragged);
  if ('polygon' in dragged) {
    const s = screen(dragged.polygon[3]!);
    close(s.x, 200, 1e-6);
    close(s.y, 500, 1e-6);
    assert.equal(geo.validatePolygon(dragged.polygon), null);
  }
  // The last edge wraps to the first corner.
  const wrap = ops.addCorner(square, 3, { x: 140, y: 400 }, { dx: 0, dy: 0 }, view);
  if ('polygon' in wrap) assert.deepEqual(wrap.polygon[4], geo.midpoint(square[3]!, square[0]!));
});

test('add corner: refused at the corner limit', () => {
  const full = Array.from({ length: geo.MAX_POLYGON_VERTICES }, (_, i) => {
    const a = (i / geo.MAX_POLYGON_VERTICES) * 2 * Math.PI;
    return ground(200 + 150 * Math.cos(a), 400 + 150 * Math.sin(a));
  });
  assert.ok('problem' in ops.addCorner(full, 0, { x: 0, y: 0 }, { dx: 0, dy: 0 }, view));
});

test('remove corner: a square becomes a triangle, a triangle keeps its three', () => {
  const removed = ops.removeCorner(square, 2);
  assert.ok('polygon' in removed);
  if ('polygon' in removed) assert.deepEqual(removed.polygon, [square[0], square[1], square[3]]);
  assert.deepEqual(ops.removeCorner(square.slice(0, 3), 0), { problem: 'A shape needs at least three corners' });
});

test('a circle edit is always valid once clamped; only polygons can be refused', () => {
  const from: FenceGeometry = { shape: 'circle', center: ground(200, 400), radiusM: 100 };
  const next: FenceGeometry = { shape: 'circle', center: ground(210, 400), radiusM: 25 };
  assert.deepEqual(ops.settleEdit(from, next, false), { geometry: next, done: true });
});
