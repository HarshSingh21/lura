import type { Point } from '@/api/types';

/**
 * The publishing gate: which raw GPS fixes are worth sending.
 *
 * A phone or browser hands out fixes far faster and far worse than a map should
 * show them — a cell-tower guess 1.2 km off, the same fix three times, a fix a
 * second while parked. Sending all of them makes the other person's map jump and
 * the geofence engine fire on noise. The rules:
 *
 *   1. Duplicates (same coordinates, accuracy and timestamp) are dropped.
 *   2. A fix worse than `maxAccuracyM` (100 m) is dropped — unless nothing better
 *      has been seen for `staleMs` (30 s), because a rough position beats a
 *      frozen one when someone walks into a building.
 *   3. While moving, at most one fix per `movingIntervalMs` (2 s); while still,
 *      one per `stillIntervalMs` (30 s) as a heartbeat — except that a fix which
 *      markedly sharpens the accuracy is sent at the moving rate, so a marker
 *      settles onto the right spot instead of sitting on the first rough guess.
 *
 * Kept pure (no React, no expo-location) so it is tested directly; useTracking
 * owns the side effects.
 */

export type RawFix = {
  point: Point;
  /** Horizontal accuracy radius in metres; undefined when the platform did not say. */
  accuracyM?: number;
  /** Ground speed in m/s; undefined or negative when unknown. */
  speedMps?: number;
  /** Course over ground, degrees clockwise from north; undefined/NaN when unknown. */
  headingDeg?: number;
  /** Platform timestamp of the fix, ms since epoch. */
  ts: number;
};

export type GateOptions = {
  maxAccuracyM: number;
  staleMs: number;
  movingIntervalMs: number;
  stillIntervalMs: number;
  movingMps: number;
};

export const DEFAULT_GATE: GateOptions = {
  maxAccuracyM: 100,
  staleMs: 30_000,
  movingIntervalMs: 2_000,
  stillIntervalMs: 30_000,
  movingMps: 1,
};

export type GateDecision =
  | { send: true; fix: SentFix; moving: boolean }
  | { send: false; reason: 'duplicate' | 'inaccurate' | 'throttled' | 'stale' };

/** SentFix is a fix as published: speed and heading filled in when the platform left them blank. */
export type SentFix = RawFix & { speedMps: number; headingDeg?: number };

const EARTH_M = 6_371_008.8;
const rad = (d: number) => (d * Math.PI) / 180;

function distanceM(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function bearingDeg(a: Point, b: Point): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const known = (v: number | undefined | null): v is number => typeof v === 'number' && Number.isFinite(v);

export class FixGate {
  private readonly opts: GateOptions;
  private lastRaw?: RawFix;
  private lastSent?: SentFix;
  private lastSentAt = 0;
  private lastGoodAt = 0;
  private startedAt?: number;

  constructor(opts: Partial<GateOptions> = {}) {
    this.opts = { ...DEFAULT_GATE, ...opts };
  }

  /** offer decides one fix. `now` is the wall clock (ms), injected for tests. */
  offer(fix: RawFix, now: number): GateDecision {
    if (this.startedAt === undefined) this.startedAt = now;
    const o = this.opts;

    const raw = this.lastRaw;
    if (
      raw &&
      raw.ts === fix.ts &&
      raw.point.lat === fix.point.lat &&
      raw.point.lon === fix.point.lon &&
      raw.accuracyM === fix.accuracyM
    ) {
      return { send: false, reason: 'duplicate' };
    }
    this.lastRaw = fix;

    // A platform replaying a cached fix older than the one already sent is not news.
    if (this.lastSent && fix.ts < this.lastSent.ts) return { send: false, reason: 'stale' };

    const acc = known(fix.accuracyM) ? fix.accuracyM : Infinity;
    const good = acc <= o.maxAccuracyM;
    if (good) {
      this.lastGoodAt = now;
    } else {
      const sinceGood = now - (this.lastGoodAt || this.startedAt);
      if (sinceGood < o.staleMs) return { send: false, reason: 'inaccurate' };
      // A poor fix is allowed through as a heartbeat, never faster.
      if (this.lastSent && now - this.lastSentAt < o.staleMs) return { send: false, reason: 'inaccurate' };
    }

    const sent = this.lastSent;
    const derivedSpeed =
      sent && fix.ts > sent.ts ? distanceM(sent.point, fix.point) / ((fix.ts - sent.ts) / 1000) : undefined;
    const speedMps = known(fix.speedMps) && fix.speedMps >= 0 ? fix.speedMps : derivedSpeed ?? 0;
    // Movement within the accuracy radius is indistinguishable from jitter.
    const moved = sent ? distanceM(sent.point, fix.point) : Infinity;
    const noise = Math.max(10, acc === Infinity ? 0 : acc, sent?.accuracyM ?? 0);
    const moving = speedMps > o.movingMps || moved > noise;

    if (sent) {
      const since = now - this.lastSentAt;
      const sharper = known(sent.accuracyM) && acc < sent.accuracyM * 0.5 && sent.accuracyM - acc > 5;
      const interval = moving || sharper ? o.movingIntervalMs : o.stillIntervalMs;
      if (since < interval) return { send: false, reason: 'throttled' };
    }

    let headingDeg: number | undefined;
    if (known(fix.headingDeg) && fix.headingDeg >= 0 && speedMps > o.movingMps) headingDeg = fix.headingDeg % 360;
    else if (sent && moving && moved >= 2) headingDeg = bearingDeg(sent.point, fix.point);

    const out: SentFix = { ...fix, speedMps: Math.max(0, speedMps), headingDeg };
    this.lastSent = out;
    this.lastSentAt = now;
    return { send: true, fix: out, moving };
  }
}

/**
 * ownTracksPayload is the /pub body for a gated fix: OwnTracks field names, plus
 * the exact `speedMps` the server prefers over the km/h `vel`.
 */
export function ownTracksPayload(fix: SentFix, seq: number, extra: { altitudeM?: number; battery?: number } = {}) {
  return {
    _type: 'location' as const,
    lat: fix.point.lat,
    lon: fix.point.lon,
    tst: Math.floor(fix.ts / 1000),
    acc: known(fix.accuracyM) ? Math.round(fix.accuracyM * 10) / 10 : undefined,
    alt: known(extra.altitudeM) ? extra.altitudeM : undefined,
    cog: known(fix.headingDeg) ? Math.round(fix.headingDeg) : undefined,
    vel: Math.round(fix.speedMps * 3.6 * 10) / 10,
    speedMps: fix.speedMps,
    batt: known(extra.battery) ? Math.round(extra.battery) : undefined,
    seq,
  };
}
