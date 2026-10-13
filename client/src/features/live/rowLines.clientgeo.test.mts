/**
 * Harsh's phone as two people see it: Harsh in "My devices" and on his own
 * marker, Nishtha in her People row and on his marker on her map. Fed the same
 * frames, both must use the same words — "Still" or "Moving · N km/h", or
 * "Last seen …" once it has gone quiet — and Nishtha must see "Paused sharing
 * with you" (not a stale position) once Harsh turns his switch off.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import '../../test/clientgeo.resolve.mts';

import type { Device, Point, Position } from '@/api/types';
import type { Peer } from '@/features/people/types';

import type { TrailPoint } from './motion.ts';

const { STALE_AFTER_MS, acceptsPosition, pushTrail, trailPointOf } = await import('./motion.ts');
const { deviceRow, markerState, peerRow } = await import('./rowLines.ts');
const { peerFixes } = await import('@/features/people/peer');

const T0 = Date.parse('2026-10-13T08:00:00Z');
const HOME: Point = { lat: 12.9716, lon: 77.5946 };
const M_PER_LON = 111_195 * Math.cos((HOME.lat * Math.PI) / 180);
const east = (m: number): Point => ({ lat: HOME.lat, lon: HOME.lon + m / M_PER_LON });

const PHONE = 'dev_harsh_phone';

function frame(t: number, point: Point, speedMps: number, over: Partial<Position> = {}): Position {
  const iso = new Date(t).toISOString();
  return {
    deviceId: PHONE,
    userId: 'usr_harsh',
    recvTs: iso,
    deviceTs: iso,
    fixTs: iso,
    point,
    accuracyM: 5,
    speedMps,
    altitudeM: 0,
    headingDeg: 0,
    battery: 80,
    seq: t,
    ...over,
  };
}

/** Client is what one signed-in viewer holds: the position store and the trail buffer (useLive). */
class Client {
  positions: Record<string, Position> = {};
  trails: Record<string, TrailPoint[]> = {};
  receive(p: Position) {
    if (acceptsPosition(this.positions[p.deviceId], p)) this.positions = { ...this.positions, [p.deviceId]: p };
    const tp = trailPointOf(p);
    if (tp) this.trails = { ...this.trails, [p.deviceId]: pushTrail(this.trails[p.deviceId], tp) };
  }
  /** snapshot is the socket's first frame, as useLive turns a device's last point into a position. */
  snapshot(point: Point, lastSeen: number, speedMps: number) {
    const iso = new Date(lastSeen).toISOString();
    this.receive({ ...frame(lastSeen, point, speedMps), recvTs: iso, deviceTs: iso, fixTs: undefined, seq: 0 });
  }
}

function harshDevice(last?: Position): Device {
  return {
    id: PHONE,
    userId: 'usr_harsh',
    name: 'Pixel',
    kind: 'phone',
    createdAt: '2026-10-01T00:00:00Z',
    lastPoint: last?.point,
    lastSeen: last?.recvTs,
    speedMps: last?.speedMps,
    battery: 80,
  };
}

/** harshAsNishthaSeesHim is Nishtha's row for Harsh, as the overview gives it. */
function harshAsNishthaSeesHim(last: Position | undefined, sharingWithMe = true): Peer {
  return {
    id: 'con_n_h',
    userId: 'usr_nishtha',
    peerId: 'usr_harsh',
    peerName: 'Harsh Singh',
    peerEmail: 'harsh@example.com',
    status: 'accepted',
    sharing: true,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    watchingMe: true,
    sharingWithMe,
    // A paused peer's overview row carries no devices at all.
    devices: sharingWithMe ? [{ id: PHONE, name: 'Pixel', point: last?.point, speedMps: last?.speedMps, lastSeen: last?.recvTs }] : null,
  };
}

/** motion is the part of a row both viewers must agree on (battery is People-only, place is mine-only). */
function motion(line: string): string {
  if (line.startsWith('Last seen ')) return line.split(' · ')[0]!;
  const [word, second] = line.split(' · ');
  return word === 'Moving' ? `${word} · ${second}` : word!;
}

function bothViews(harsh: Client, nishtha: Client, last: Position, now: number) {
  const mine = deviceRow(harshDevice(last), harsh.positions, harsh.trails, [], now);
  const theirs = peerRow(harshAsNishthaSeesHim(last), nishtha.positions, nishtha.trails, now);
  const myMarker = markerState('Pixel', harsh.trails[PHONE], last.speedMps, mine.lastSeenMs, now);
  const fix = theirs.fix!;
  const theirMarker = markerState('Harsh Singh', nishtha.trails[PHONE], fix.speedMps, fix.lastSeen ? Date.parse(fix.lastSeen) : undefined, now);
  return { mine, theirs, myMarker, theirMarker };
}

function assertAgree(v: ReturnType<typeof bothViews>, expected: string) {
  assert.equal(motion(v.mine.line), expected, `Harsh's row: ${v.mine.line}`);
  assert.equal(motion(v.theirs.line), expected, `Nishtha's row: ${v.theirs.line}`);
  // The markers carry the same state: a speed while moving, nothing while still, hollow when stale.
  const tail = (label: string) => label.split(' · ').slice(1).join(' · ');
  assert.equal(tail(v.myMarker.label), tail(v.theirMarker.label));
  assert.equal(v.myMarker.stale, v.theirMarker.stale);
  assert.equal(v.myMarker.pulse, v.theirMarker.pulse);
}

test('a phone on a table reads "Still" to its owner and to the person it shares with', () => {
  const harsh = new Client();
  const nishtha = new Client();
  let last!: Position;
  // Heartbeats every 30 s at the same point, speed 0 (hooks/fixGate).
  for (let i = 0; i < 4; i += 1) {
    last = frame(T0 + i * 30_000, HOME, 0);
    harsh.receive(last);
    nishtha.receive(last);
  }
  const v = bothViews(harsh, nishtha, last, last && Date.parse(last.recvTs) + 4_000);
  assertAgree(v, 'Still');
  assert.equal(v.mine.line, 'Still · 4s ago');
  assert.equal(v.theirs.line, 'Still · 4s ago · 80% battery');
  assert.equal(v.myMarker.label, 'Pixel');
  assert.equal(v.theirMarker.label, 'Harsh Singh');
});

test('walking and driving read "Moving" with the same speed on both sides', () => {
  for (const [mps, words] of [
    [1.4, 'Moving · 5 km/h'],
    [8, 'Moving · 29 km/h'],
  ] as const) {
    const harsh = new Client();
    const nishtha = new Client();
    let last!: Position;
    for (let i = 0; i < 5; i += 1) {
      last = frame(T0 + i * 2000, east(i * 2 * mps), mps);
      harsh.receive(last);
      nishtha.receive(last);
    }
    const v = bothViews(harsh, nishtha, last, Date.parse(last.recvTs) + 1_000);
    assertAgree(v, words);
    assert.equal(v.myMarker.label, `Pixel · ${words.slice('Moving · '.length)}`);
  }
});

test('a device that sent no speed is "Moving" to both when both saw it move', () => {
  const harsh = new Client();
  const nishtha = new Client();
  let last!: Position;
  // 10 m every second with speed 0 (an OwnTracks client without vel): derived 10 m/s.
  for (let i = 0; i < 4; i += 1) {
    last = frame(T0 + i * 1000, east(i * 10), 0);
    harsh.receive(last);
    nishtha.receive(last);
  }
  assertAgree(bothViews(harsh, nishtha, last, Date.parse(last.recvTs) + 500), 'Moving · 36 km/h');
});

test('Nishtha opening the app mid-walk agrees with Harsh from her first frame', () => {
  const harsh = new Client();
  let last!: Position;
  for (let i = 0; i < 6; i += 1) {
    last = frame(T0 + i * 2000, east(i * 16), 8);
    harsh.receive(last);
  }
  // Nishtha's socket opens now: the snapshot carries his phone's last point and speed.
  const nishtha = new Client();
  nishtha.snapshot(last.point, Date.parse(last.recvTs), last.speedMps);
  // Her frame then repeats the same fix (the snapshot and the live frame race).
  nishtha.receive(last);
  assert.equal(nishtha.trails[PHONE]!.length, 1, 'the replayed fix is one trail point, not two');
  assertAgree(bothViews(harsh, nishtha, last, Date.parse(last.recvTs) + 3_000), 'Moving · 29 km/h');
  // And on the next fix, still in step.
  const next = frame(Date.parse(last.recvTs) + 2000, east(6 * 16), 8);
  harsh.receive(next);
  nishtha.receive(next);
  assertAgree(bothViews(harsh, nishtha, next, Date.parse(next.recvTs) + 1_000), 'Moving · 29 km/h');
});

test('a device that sent no speed: a viewer who joins mid-walk is in step from the next fix', () => {
  // Known limit: a speed derived from the last two fixes needs two fixes, and
  // a viewer that just opened holds one (the snapshot). Lura's own publishers
  // always send a speed (hooks/fixGate), so this is only a speedless client.
  const harsh = new Client();
  let last!: Position;
  for (let i = 0; i < 4; i += 1) {
    last = frame(T0 + i * 1000, east(i * 10), 0);
    harsh.receive(last);
  }
  const nishtha = new Client();
  nishtha.snapshot(last.point, Date.parse(last.recvTs), 0);
  const next = frame(T0 + 4000, east(40), 0);
  harsh.receive(next);
  nishtha.receive(next);
  assertAgree(bothViews(harsh, nishtha, next, T0 + 4500), 'Moving · 36 km/h');
});

test('a phone that went quiet reads "Last seen" to both, and its marker turns hollow for both', () => {
  const harsh = new Client();
  const nishtha = new Client();
  const last = frame(T0, east(100), 8);
  harsh.receive(last);
  nishtha.receive(last);
  // Just before the threshold: still live, still moving.
  const fresh = bothViews(harsh, nishtha, last, T0 + STALE_AFTER_MS - 1_000);
  assertAgree(fresh, 'Moving · 29 km/h');
  assert.equal(fresh.theirs.fresh, true);
  assert.equal(fresh.theirMarker.pulse, true);
  // Three minutes on: where he *was*.
  const v = bothViews(harsh, nishtha, last, T0 + 180_000);
  assertAgree(v, 'Last seen 3 min ago');
  assert.equal(v.myMarker.stale, true);
  assert.equal(v.theirMarker.label, 'Harsh Singh · 3 min ago');
  assert.equal(v.theirMarker.pulse, false);
  assert.equal(v.theirs.fresh, false);
});

test('a stale phone is stale from the snapshot alone, after a reload', () => {
  const last = frame(T0, east(100), 8);
  const nishtha = new Client();
  nishtha.snapshot(last.point, T0, 8);
  const row = peerRow(harshAsNishthaSeesHim(last), nishtha.positions, nishtha.trails, T0 + 10 * 60_000);
  assert.equal(row.line, 'Last seen 10 min ago');
  // With no socket frame at all (the overview only), the same.
  const cold = peerRow(harshAsNishthaSeesHim(last), {}, {}, T0 + 10 * 60_000);
  assert.equal(cold.line, 'Last seen 10 min ago');
  const mine = deviceRow(harshDevice(last), {}, {}, [], T0 + 10 * 60_000);
  assert.equal(mine.line, 'Last seen 10 min ago');
});

test('paused: Nishtha sees "Paused sharing with you", never his last position, even with his frames still held', () => {
  const nishtha = new Client();
  const last = frame(T0, east(50), 8);
  nishtha.receive(last);
  // Harsh turns his switch off: the next overview names no devices for him.
  const paused = harshAsNishthaSeesHim(last, false);
  assert.deepEqual(peerFixes(paused, nishtha.positions), []);
  const row = peerRow(paused, nishtha.positions, nishtha.trails, T0 + 1_000);
  assert.equal(row.line, 'Paused sharing with you');
  assert.equal(row.fix, undefined);
  assert.equal(row.fresh, false);
});

test('sharing but nothing reported yet says so, and is not "paused"', () => {
  const peer = harshAsNishthaSeesHim(undefined);
  peer.devices = [{ id: PHONE, name: 'Pixel' }];
  assert.equal(peerRow(peer, {}, {}, T0).line, 'Sharing · no fix yet');
  const mine = deviceRow(harshDevice(undefined), {}, {}, [], T0);
  assert.equal(mine.line, 'No fix yet');
});

test('my still phone names the place it is in; the peer row does not', () => {
  const harsh = new Client();
  const last = frame(T0, HOME, 0);
  harsh.receive(last);
  const device = { ...harshDevice(last), insidePlaces: ['plc_home'] };
  const places = [{ id: 'plc_home', name: 'Home' }] as unknown as Parameters<typeof deviceRow>[3];
  assert.equal(deviceRow(device, harsh.positions, harsh.trails, places, T0 + 2_000).line, 'Still · Home · 2s ago');
});
