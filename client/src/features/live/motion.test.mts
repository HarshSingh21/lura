import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Position } from '@/api/types';

import {
  bearingDeg,
  colorForUser,
  distanceM,
  fixTimeMs,
  formatAge,
  isStale,
  STALE_AFTER_MS,
  glideMsFor,
  headingFor,
  JUMP_M,
  lerpPoint,
  MAX_GLIDE_MS,
  PERSON_PALETTE,
  pushTrail,
  speedOf,
  TRAIL_MAX_POINTS,
  trailPointOf,
  type TrailPoint,
} from './motion.ts';

const BLR = { lat: 12.9716, lon: 77.5946 };

/** north moves a point `m` metres due north. */
function north(p: { lat: number; lon: number }, m: number) {
  return { lat: p.lat + m / 111_195, lon: p.lon };
}

function tp(point: { lat: number; lon: number }, t: number, extra: Partial<TrailPoint> = {}): TrailPoint {
  return { point, t, speedMps: 0, headingDeg: 0, accuracyM: 5, battery: 0, ...extra };
}

test('colorForUser is stable, in the palette, and reserves the accent for me', () => {
  const a = colorForUser('user_nishtha');
  assert.equal(a, colorForUser('user_nishtha'));
  assert.ok((PERSON_PALETTE as readonly string[]).includes(a));
  assert.equal(colorForUser('user_harsh', 'user_harsh', '#20a07b'), '#20a07b');
  // Peers never get the accent.
  for (let i = 0; i < 200; i += 1) assert.notEqual(colorForUser(`u${i}`, 'me'), '#20a07b');
  // And the hash actually spreads ids across the palette.
  const used = new Set(Array.from({ length: 200 }, (_, i) => colorForUser(`user_${i}`)));
  assert.ok(used.size >= PERSON_PALETTE.length - 1);
});

test('distance and bearing agree with known geometry', () => {
  const p = north(BLR, 1000);
  assert.ok(Math.abs(distanceM(BLR, p) - 1000) < 1);
  assert.ok(Math.abs(bearingDeg(BLR, p) - 0) < 0.01 || Math.abs(bearingDeg(BLR, p) - 360) < 0.01);
  const east = { lat: BLR.lat, lon: BLR.lon + 0.01 };
  assert.ok(Math.abs(bearingDeg(BLR, east) - 90) < 0.1);
  assert.ok(Math.abs(bearingDeg(east, BLR) - 270) < 0.1);
});

test('trailPointOf reads a frame and rejects broken ones', () => {
  const frame: Position = {
    deviceId: 'd',
    userId: 'u',
    recvTs: '2026-10-12T10:00:00Z',
    deviceTs: '2026-10-12T10:00:00Z',
    point: BLR,
    accuracyM: 8,
    speedMps: 3,
    altitudeM: 0,
    headingDeg: 45,
    battery: 80,
    seq: 1,
  };
  const point = trailPointOf(frame);
  assert.ok(point);
  assert.equal(point.t, Date.parse('2026-10-12T10:00:00Z'));
  assert.equal(point.headingDeg, 45);
  assert.equal(trailPointOf({ ...frame, recvTs: 'nope' }), null);
});

test('pushTrail keeps order, drops replays, caps length and breaks on jumps', () => {
  let trail: TrailPoint[] = [];
  for (let i = 0; i < TRAIL_MAX_POINTS + 10; i += 1) trail = pushTrail(trail, tp(north(BLR, i * 10), 1000 * i));
  assert.equal(trail.length, TRAIL_MAX_POINTS);
  assert.equal(trail[trail.length - 1]?.t, 1000 * (TRAIL_MAX_POINTS + 9));

  // An older frame (a replayed snapshot) and an exact duplicate change nothing.
  const last = trail[trail.length - 1]!;
  assert.equal(pushTrail(trail, tp(BLR, 5)), trail);
  assert.equal(pushTrail(trail, { ...last }), trail);

  // A jump starts a new trail rather than drawing a line across the city.
  const jumped = pushTrail(trail, tp(north(last.point, JUMP_M + 100), last.t + 1000));
  assert.equal(jumped.length, 1);
});

test('headingFor: device course when moving, bearing as fallback, nothing when still', () => {
  const a = tp(BLR, 0);
  const b = tp(north(BLR, 20), 2000, { speedMps: 10, headingDeg: 135 });
  assert.equal(headingFor([a, b]), 135);
  // No course reported: bearing between the last two fixes (due north).
  const c = tp(north(BLR, 20), 2000, { speedMps: 10 });
  const h = headingFor([a, c]);
  assert.ok(h !== undefined && (h < 0.5 || h > 359.5));
  // No speed reported either: derived from the fixes (10 m/s) — still a cone.
  assert.notEqual(headingFor([a, tp(north(BLR, 20), 2000)]), undefined);
  // Standing still: no cone, whatever the course says.
  assert.equal(headingFor([a, tp(north(BLR, 1), 2000, { speedMps: 0.3, headingDeg: 200 })]), undefined);
  assert.equal(headingFor([]), undefined);
});

test('glideMsFor matches the ping gap, capped, and never glides a first fix or a jump', () => {
  assert.equal(glideMsFor([tp(BLR, 0)]), 0);
  assert.equal(glideMsFor([tp(BLR, 0), tp(north(BLR, 10), 900)]), 900);
  assert.equal(glideMsFor([tp(BLR, 0), tp(north(BLR, 10), 20_000)]), MAX_GLIDE_MS);
  assert.equal(glideMsFor([tp(BLR, 0), tp(north(BLR, JUMP_M + 1), 2000)]), 0);
});

test('speedOf prefers the device speed and derives it otherwise', () => {
  assert.equal(speedOf([tp(BLR, 0), tp(north(BLR, 10), 2000, { speedMps: 7 })]), 7);
  assert.ok(Math.abs(speedOf([tp(BLR, 0), tp(north(BLR, 10), 2000)]) - 5) < 0.05);
  assert.equal(speedOf([tp(BLR, 0)]), 0);
  // A 2 km "move" in one second is a GPS spike, not a speed.
  assert.equal(speedOf([tp(BLR, 0), tp(north(BLR, 2000), 1000)]), 0);
});

test('formatAge reads like a person would say it', () => {
  assert.equal(formatAge(500), 'just now');
  assert.equal(formatAge(3_400), '3s ago');
  assert.equal(formatAge(125_000), '2 min ago');
  assert.equal(formatAge(3 * 3_600_000), '3 h ago');
  assert.equal(formatAge(-5_000), 'just now');
});

test('lerpPoint clamps to the segment', () => {
  const b = north(BLR, 100);
  assert.deepEqual(lerpPoint(BLR, b, 0), BLR);
  assert.deepEqual(lerpPoint(BLR, b, 2), b);
  assert.ok(Math.abs(distanceM(BLR, lerpPoint(BLR, b, 0.5)) - 50) < 0.1);
});

test('a fix is dated by the server-corrected fixTs, never by the raw device clock', () => {
  const recvTs = '2026-10-12T12:10:00Z';
  // A laptop ten minutes slow, sending live: the server says it is now.
  assert.equal(fixTimeMs({ recvTs, fixTs: recvTs }), Date.parse(recvTs));
  // A queued fix: there five minutes ago.
  assert.equal(fixTimeMs({ recvTs, fixTs: '2026-10-12T12:05:00Z' }), Date.parse('2026-10-12T12:05:00Z'));
  // An older server (no fixTs), or a fixTs from the future: the arrival.
  assert.equal(fixTimeMs({ recvTs }), Date.parse(recvTs));
  assert.equal(fixTimeMs({ recvTs, fixTs: '2026-10-12T12:20:00Z' }), Date.parse(recvTs));
});

test('a device goes stale two minutes after its last fix, not before', () => {
  const t = Date.parse('2026-10-12T12:00:00Z');
  assert.equal(isStale(t, t + STALE_AFTER_MS - 1), false);
  assert.equal(isStale(t, t + STALE_AFTER_MS), true);
  assert.equal(isStale(undefined, t), false);
  assert.equal(isStale(Number.NaN, t), false);
});
