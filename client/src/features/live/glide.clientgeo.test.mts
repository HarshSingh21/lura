/**
 * A live marker between fixes: how it glides (animateMs), which way its cone
 * points, that it never steps backwards when a frame arrives late or twice, that
 * it never slides across a jump, and how its wake fades.
 *
 * The frames go through the same rules the app applies to them: the position
 * store's drop-to-latest (acceptsPosition), the trail buffer (pushTrail), and
 * the marker's retargeting glide (Overlays.tsx LiveMarker: on every new fix it
 * tweens linearly from wherever it is now to the fix, over glideMsFor).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Point, Position } from '@/api/types';

import {
  JUMP_M,
  MAX_GLIDE_MS,
  TRAIL_MAX_POINTS,
  acceptsPosition,
  distanceM,
  glideMsFor,
  headingFor,
  lerpPoint,
  pushTrail,
  trailPointOf,
  trailSegments,
  type TrailPoint,
} from './motion.ts';

const START = { lat: 12.9716, lon: 77.5946 };
const T0 = Date.parse('2026-10-13T08:00:00Z');
/** Metres per degree of longitude at START. */
const M_PER_LON = 111_195 * Math.cos((START.lat * Math.PI) / 180);

function east(m: number): Point {
  return { lat: START.lat, lon: START.lon + m / M_PER_LON };
}

function frame(i: number, over: Partial<Position> = {}): Position {
  const recv = new Date(T0 + i * 1000).toISOString();
  return {
    deviceId: 'dev_harsh_phone',
    userId: 'usr_harsh',
    recvTs: recv,
    deviceTs: recv,
    fixTs: recv,
    point: east(i * 10), // 10 m/s due east, one fix a second
    accuracyM: 5,
    speedMps: 10,
    altitudeM: 0,
    headingDeg: 0,
    battery: 80,
    seq: i,
    ...over,
  };
}

/**
 * Viewer is one client's live state for one device: what the store holds,
 * what the trail holds, and where the marker is drawn at any instant.
 */
class Viewer {
  position: Position | undefined;
  trail: TrailPoint[] = [];
  private from: Point | undefined;
  private to: Point | undefined;
  private start = 0;
  private dur = 0;

  /** receive is a frame reaching this client at wall-clock `at`. */
  receive(p: Position, at: number) {
    if (acceptsPosition(this.position, p)) this.position = p;
    const tp = trailPointOf(p);
    if (tp) this.trail = pushTrail(this.trail, tp);
    const point = this.position?.point;
    if (!point) return;
    // LiveMarker's effect runs when the point or animateMs changes.
    if (this.to && point.lat === this.to.lat && point.lon === this.to.lon) return;
    const animateMs = glideMsFor(this.trail);
    this.from = this.to ? this.at(at) : point;
    this.to = point;
    this.start = at;
    this.dur = animateMs;
  }

  /** at is where the marker is drawn at wall-clock `t`. */
  at(t: number): Point {
    if (!this.to || !this.from) throw new Error('no marker yet');
    if (this.dur <= 0) return this.to;
    return lerpPoint(this.from, this.to, (t - this.start) / this.dur);
  }
}

/** run plays frames (each with its arrival time) and samples the marker every 16 ms. */
function run(viewer: Viewer, deliveries: { p: Position; at: number }[], until: number) {
  const sorted = deliveries.slice().sort((a, b) => a.at - b.at);
  const samples: { t: number; p: Point }[] = [];
  let k = 0;
  for (let t = sorted[0]!.at; t <= until; t += 16) {
    while (k < sorted.length && sorted[k]!.at <= t) {
      viewer.receive(sorted[k]!.p, sorted[k]!.at);
      k += 1;
    }
    samples.push({ t, p: viewer.at(t) });
  }
  return samples;
}

test('glide: each fix glides for the gap since the last one, capped, and the first fix does not glide', () => {
  const v = new Viewer();
  v.receive(frame(0), T0);
  assert.equal(glideMsFor(v.trail), 0);
  v.receive(frame(1), T0 + 1000);
  assert.equal(glideMsFor(v.trail), 1000);
  // A fix after a 10 s gap glides at most MAX_GLIDE_MS.
  v.receive(frame(11), T0 + 11_000);
  assert.equal(glideMsFor(v.trail), MAX_GLIDE_MS);
});

test('glide: a steady walk is drawn as continuous motion — forwards only, no jumps, arriving on each fix', () => {
  const v = new Viewer();
  // Network jitter: each frame lands 50–350 ms after it was received by the server.
  const deliveries = Array.from({ length: 20 }, (_, i) => ({ p: frame(i), at: T0 + i * 1000 + 50 + ((i * 137) % 300) }));
  const samples = run(v, deliveries, T0 + 21_000);
  let maxStep = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const a = samples[i - 1]!.p;
    const b = samples[i]!.p;
    assert.ok(b.lon >= a.lon - 1e-12, `moved backwards at ${samples[i]!.t - T0} ms`);
    maxStep = Math.max(maxStep, distanceM(a, b));
  }
  // 10 m/s is 0.16 m per 16 ms frame. Catching up after a late frame may run
  // faster for a moment, but never anything like a jump.
  assert.ok(maxStep < 0.6, `largest step ${maxStep.toFixed(3)} m`);
  // And it ends exactly on the last fix.
  const last = samples[samples.length - 1]!.p;
  assert.deepEqual(last, frame(19).point);
});

test('glide: a late or replayed frame never moves the marker backwards', () => {
  const v = new Viewer();
  const deliveries = [
    { p: frame(0), at: T0 + 100 },
    { p: frame(1), at: T0 + 1100 },
    { p: frame(3), at: T0 + 3100 },
    // Frame 2 overtaken on the network: it arrives after 3.
    { p: frame(2), at: T0 + 3300 },
    // The reconnect snapshot replays the newest fix the server holds (as the
    // client builds it from lastSeen/lastPoint: no fixTs, recvTs = lastSeen).
    { p: { ...frame(3), fixTs: undefined, seq: 0 }, at: T0 + 3500 },
    // A queued fix the server marks late: it arrives last, and is history.
    { p: { ...frame(1), recvTs: new Date(T0 + 3600).toISOString(), late: true }, at: T0 + 3700 },
    { p: frame(4), at: T0 + 4100 },
  ];
  const samples = run(v, deliveries, T0 + 6000);
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(samples[i]!.p.lon >= samples[i - 1]!.p.lon - 1e-12, `backwards at ${samples[i]!.t - T0} ms`);
  }
  assert.equal(v.position?.seq, 4);
  // The wake holds each fix once, in order: the late and replayed frames left no trace.
  assert.deepEqual(
    v.trail.map((p) => Math.round((p.point.lon - START.lon) * M_PER_LON)),
    [0, 10, 30, 40],
  );
});

test('glide: the store and the trail agree about which frame is newest', () => {
  const held = frame(5);
  assert.equal(acceptsPosition(undefined, held), true);
  assert.equal(acceptsPosition(held, frame(6)), true);
  assert.equal(acceptsPosition(held, frame(4)), false);
  // Same arrival time: the newer frame wins (the trail then dedupes it if identical).
  assert.equal(acceptsPosition(held, frame(5, { point: east(51) })), true);
  assert.equal(acceptsPosition(held, { ...frame(6), late: true }), false);
  assert.equal(trailPointOf({ ...frame(6), late: true }), null);
});

test('glide: a jump of more than 5 km starts a new trail and does not slide across the map', () => {
  const v = new Viewer();
  v.receive(frame(0), T0);
  v.receive(frame(1), T0 + 1000);
  const far = frame(2, { point: east(JUMP_M + 35_000) });
  v.receive(far, T0 + 2000);
  assert.equal(v.trail.length, 1);
  assert.equal(glideMsFor(v.trail), 0);
  // Drawn at the new place at once, not 40 km of interpolated map in between.
  assert.deepEqual(v.at(T0 + 2001), far.point);
});

test('heading: points the way it is going, holds through late frames, and is gone when still', () => {
  const v = new Viewer();
  // A phone that reports no course (heading 0): the bearing of the last two fixes stands in.
  for (let i = 0; i < 3; i += 1) v.receive(frame(i), T0 + i * 1000);
  const h = headingFor(v.trail);
  assert.ok(h !== undefined && Math.abs(h - 90) < 0.5, `heading ${h}`);
  // A late frame does not turn the cone round.
  v.receive({ ...frame(0), recvTs: new Date(T0 + 2500).toISOString(), late: true }, T0 + 2600);
  v.receive(frame(1), T0 + 2700);
  assert.ok(Math.abs((headingFor(v.trail) ?? -1) - 90) < 0.5);
  // The device's own course wins while moving.
  v.receive(frame(3, { headingDeg: 75 }), T0 + 3000);
  assert.equal(headingFor(v.trail), 75);
  // Standing still (heartbeats at the same point, speed 0): no cone.
  const still = new Viewer();
  for (let i = 0; i < 4; i += 1) still.receive(frame(i, { point: START, speedMps: 0, headingDeg: 200 }), T0 + i * 30_000);
  assert.equal(headingFor(still.trail), undefined);
});

test('trail: the wake fades and thins towards its oldest end', () => {
  assert.deepEqual(trailSegments(0), []);
  assert.deepEqual(trailSegments(1), []);
  // Two fixes: one segment, drawn at full strength.
  const [only] = trailSegments(2);
  assert.ok(only);
  close(only!.opacity, 0.8);
  close(only!.width, 4.5);
  const segs = trailSegments(TRAIL_MAX_POINTS);
  assert.equal(segs.length, TRAIL_MAX_POINTS - 1);
  for (let k = 1; k < segs.length; k += 1) {
    assert.ok(segs[k]!.opacity > segs[k - 1]!.opacity, 'opacity rises with recency');
    assert.ok(segs[k]!.width > segs[k - 1]!.width, 'width rises with recency');
    assert.ok(segs[k]!.casingOpacity > segs[k - 1]!.casingOpacity);
    assert.ok(segs[k]!.casingWidth > segs[k - 1]!.casingWidth);
  }
  // The tail is faint but there; the head is strong; nothing exceeds full opacity.
  assert.ok(segs[0]!.opacity < 0.1);
  close(segs[segs.length - 1]!.opacity, 0.8);
  for (const s of segs) assert.ok(s.opacity > 0 && s.opacity <= 1 && s.casingOpacity >= 0 && s.casingOpacity <= 1);
  // Each segment joins fix i-1 to fix i, in order.
  assert.deepEqual(
    segs.map((s) => s.i),
    Array.from({ length: TRAIL_MAX_POINTS - 1 }, (_, k) => k + 1),
  );
});

test('trail: the wake keeps the last 30 fixes, oldest first', () => {
  const v = new Viewer();
  for (let i = 0; i < 45; i += 1) v.receive(frame(i), T0 + i * 1000);
  assert.equal(v.trail.length, TRAIL_MAX_POINTS);
  assert.equal(v.trail[0]!.t, T0 + 15_000);
  assert.equal(v.trail[TRAIL_MAX_POINTS - 1]!.t, T0 + 44_000);
});

function close(actual: number, expected: number, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}
