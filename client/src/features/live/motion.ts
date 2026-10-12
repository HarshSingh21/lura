import type { Point, Position } from '@/api/types';

/**
 * Pure helpers for drawing live movement: whose colour a marker is, which way it
 * is heading, how long the glide to its next fix should take, and the short trail
 * behind it.
 *
 * Free of React and of runtime imports on purpose — the rules here decide whether
 * a marker looks like a person moving or a dot teleporting, and they are tested
 * with plain `node --test` (see motion.test.ts).
 */

/** How many recent fixes a live device keeps for its trail. */
export const TRAIL_MAX_POINTS = 30;

/** The longest glide between two fixes; longer gaps glide this long and no longer. */
export const MAX_GLIDE_MS = 1500;

/** Below this speed a device is treated as standing still (walking is ~1.4 m/s). */
export const MOVING_MPS = 1;

/** Fixes further apart than this are a jump (a tunnel, a cold start), not a glide. */
export const JUMP_M = 5_000;

/**
 * Person colours. The brand green is reserved for "me", and amber stays the
 * colour sharing *about* me is drawn in elsewhere, so peers draw from hues that
 * read as distinct from both and from each other on light, dark and satellite
 * basemaps alike. features/people/color.ts carries the same list for toasts and
 * the People screen; keep the two in step.
 */
export const PERSON_PALETTE = ['#7c5cff', '#e0568f', '#2f80ed', '#e5603b', '#0aa2c0', '#b5651d', '#c03fd6', '#d29a00'] as const;

/** colorForUser hashes a user id into the person palette: stable across sessions and devices. */
export function colorForUser(userId: string, meId?: string, meColor = '#20a07b'): string {
  if (meId && userId === meId) return meColor;
  let h = 2166136261; // FNV-1a: tiny, and well distributed for short ids
  for (let i = 0; i < userId.length; i += 1) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const index = (h >>> 0) % PERSON_PALETTE.length;
  return PERSON_PALETTE[index] ?? PERSON_PALETTE[0];
}

const EARTH_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

/** distanceM is the haversine distance between two points, in metres. */
export function distanceM(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** bearingDeg is the initial great-circle bearing from a to b, degrees clockwise from north. */
export function bearingDeg(a: Point, b: Point): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** TrailPoint is one received fix, kept for the trail and for heading/glide decisions. */
export type TrailPoint = {
  point: Point;
  /** Server receive time, ms since epoch: the clock every viewer shares. */
  t: number;
  speedMps: number;
  /** As reported by the device; 0 is what the server sends when there was none. */
  headingDeg: number;
  accuracyM: number;
  battery: number;
};

export function trailPointOf(p: Position): TrailPoint | null {
  const t = new Date(p.recvTs).getTime();
  if (!Number.isFinite(t) || !Number.isFinite(p.point?.lat) || !Number.isFinite(p.point?.lon)) return null;
  return {
    point: p.point,
    t,
    speedMps: Number.isFinite(p.speedMps) ? Math.max(0, p.speedMps) : 0,
    headingDeg: Number.isFinite(p.headingDeg) ? p.headingDeg : 0,
    accuracyM: Number.isFinite(p.accuracyM) ? Math.max(0, p.accuracyM) : 0,
    battery: Number.isFinite(p.battery) ? p.battery : 0,
  };
}

/**
 * pushTrail appends a fix to a device's buffer and returns the new buffer (or the
 * same one when nothing changed, so a store can skip the update).
 *
 * Out-of-order and duplicate frames are ignored — the WebSocket can replay the
 * snapshot's last fix right after a live one — and a fix far from the previous
 * one starts a fresh trail, because a line drawn across a 40 km jump is a lie.
 */
export function pushTrail(buffer: readonly TrailPoint[] | undefined, next: TrailPoint, max = TRAIL_MAX_POINTS): TrailPoint[] {
  const prev = buffer ?? [];
  const last = prev[prev.length - 1];
  if (last) {
    if (next.t < last.t) return prev as TrailPoint[];
    if (next.t === last.t && next.point.lat === last.point.lat && next.point.lon === last.point.lon) {
      return prev as TrailPoint[];
    }
    if (distanceM(last.point, next.point) > JUMP_M) return [next];
  }
  const out = [...prev, next];
  return out.length > max ? out.slice(out.length - max) : out;
}

/**
 * headingFor decides the heading cone for the newest fix in a buffer, or
 * `undefined` for no cone.
 *
 * A standing device has no meaningful heading (GPS course wanders at walking
 * speed and below), so the cone only shows while moving. The device's own course
 * wins when it reported one; otherwise the bearing between the last two fixes
 * stands in, as long as they are far enough apart to point somewhere.
 */
export function headingFor(buffer: readonly TrailPoint[]): number | undefined {
  const last = buffer[buffer.length - 1];
  if (!last) return undefined;
  const prev = buffer[buffer.length - 2];
  const derivedSpeed = prev && last.t > prev.t ? distanceM(prev.point, last.point) / ((last.t - prev.t) / 1000) : 0;
  const speed = last.speedMps > 0 ? last.speedMps : derivedSpeed;
  if (speed <= MOVING_MPS) return undefined;
  if (last.headingDeg > 0 && last.headingDeg <= 360) return last.headingDeg % 360;
  if (!prev) return undefined;
  if (distanceM(prev.point, last.point) < 2) return undefined;
  return bearingDeg(prev.point, last.point);
}

/**
 * glideMsFor is how long a marker should take to slide to the newest fix.
 *
 * Matching the gap between fixes makes motion continuous — the marker arrives
 * just as the next fix does — but is capped, because a marker crawling for thirty
 * seconds behind a person who stopped long ago is worse than a quick hop. The
 * first fix and a jump do not glide at all.
 */
export function glideMsFor(buffer: readonly TrailPoint[]): number {
  const last = buffer[buffer.length - 1];
  const prev = buffer[buffer.length - 2];
  if (!last || !prev) return 0;
  if (distanceM(prev.point, last.point) > JUMP_M) return 0;
  const gap = last.t - prev.t;
  if (gap <= 0) return 0;
  return Math.min(gap, MAX_GLIDE_MS);
}

/** speedOf is the newest fix's speed, derived from the last two fixes when the device sent none. */
export function speedOf(buffer: readonly TrailPoint[]): number {
  const last = buffer[buffer.length - 1];
  if (!last) return 0;
  if (last.speedMps > 0) return last.speedMps;
  const prev = buffer[buffer.length - 2];
  if (!prev || last.t <= prev.t) return 0;
  const s = distanceM(prev.point, last.point) / ((last.t - prev.t) / 1000);
  // A jittering standing fix can "move" 15 m in a second; ignore implausible spikes.
  return s < 70 ? s : 0;
}

/** formatAge writes "3s ago" / "4 min ago" for a ping, from ms since it arrived. */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 2) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** formatSpeed writes km/h, the unit people read on a map. */
export function formatSpeed(mps: number): string {
  return `${Math.round(Math.max(0, mps) * 3.6)} km/h`;
}

/** lerpPoint interpolates linearly between two points (fine at the scale of one glide). */
export function lerpPoint(a: Point, b: Point, t: number): Point {
  const k = Math.max(0, Math.min(1, t));
  return { lat: a.lat + (b.lat - a.lat) * k, lon: a.lon + (b.lon - a.lon) * k };
}
