import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FixGate, ownTracksPayload, type RawFix } from './fixGate.ts';

const BLR = { lat: 12.9716, lon: 77.5946 };
const T0 = 1_760_000_000_000;

function north(m: number) {
  return { lat: BLR.lat + m / 111_195, lon: BLR.lon };
}

function fix(over: Partial<RawFix> & { at: number }): RawFix {
  return { point: BLR, accuracyM: 8, ts: T0 + over.at, ...over };
}

test('sends the first good fix immediately', () => {
  const gate = new FixGate();
  const d = gate.offer(fix({ at: 0 }), T0);
  assert.equal(d.send, true);
});

test('drops exact duplicates', () => {
  const gate = new FixGate();
  const f = fix({ at: 0 });
  gate.offer(f, T0);
  assert.deepEqual(gate.offer({ ...f }, T0 + 5_000), { send: false, reason: 'duplicate' });
});

test('drops fixes worse than 100 m until nothing better has come for 30 s', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, accuracyM: 8 }), T0).send, true);
  // A cell-tower guess right after a good fix: held back.
  assert.deepEqual(gate.offer(fix({ at: 5_000, accuracyM: 900, point: north(500) }), T0 + 5_000), {
    send: false,
    reason: 'inaccurate',
  });
  // Still nothing good after 30 s: a rough position beats a frozen one.
  assert.equal(gate.offer(fix({ at: 31_000, accuracyM: 900, point: north(500) }), T0 + 31_000).send, true);
  // …but only as a heartbeat, never at the moving rate.
  assert.equal(gate.offer(fix({ at: 34_000, accuracyM: 850, point: north(600) }), T0 + 34_000).send, false);
});

test('a cold start with only rough fixes waits 30 s before sending one', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, accuracyM: 400 }), T0).send, false);
  assert.equal(gate.offer(fix({ at: 10_000, accuracyM: 400 }), T0 + 10_000).send, false);
  assert.equal(gate.offer(fix({ at: 30_000, accuracyM: 400 }), T0 + 30_000).send, true);
});

test('missing accuracy counts as unknown, not perfect', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, accuracyM: undefined }), T0).send, false);
});

test('while moving: at most one fix per 2 s', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, speedMps: 5 }), T0).send, true);
  assert.equal(gate.offer(fix({ at: 1_000, speedMps: 5, point: north(5) }), T0 + 1_000).send, false);
  const d = gate.offer(fix({ at: 2_000, speedMps: 5, point: north(10) }), T0 + 2_000);
  assert.equal(d.send, true);
  assert.equal(d.send && d.moving, true);
});

test('while still: one heartbeat per 30 s', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, speedMps: 0 }), T0).send, true);
  // Jitter inside the accuracy radius is not movement.
  assert.equal(gate.offer(fix({ at: 3_000, speedMps: 0, point: north(3) }), T0 + 3_000).send, false);
  assert.equal(gate.offer(fix({ at: 20_000, speedMps: 0, point: north(2) }), T0 + 20_000).send, false);
  assert.equal(gate.offer(fix({ at: 30_000, speedMps: 0, point: north(1) }), T0 + 30_000).send, true);
});

test('moving is detected from distance when the platform reports no speed (web)', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, speedMps: undefined }), T0).send, true);
  const d = gate.offer(fix({ at: 3_000, speedMps: undefined, point: north(30) }), T0 + 3_000);
  assert.equal(d.send, true);
  assert.ok(d.send && Math.abs(d.fix.speedMps - 10) < 0.1, 'speed derived from the two fixes');
  assert.ok(d.send && d.fix.headingDeg !== undefined && (d.fix.headingDeg < 1 || d.fix.headingDeg > 359), 'heading north');
});

test('a markedly sharper fix is sent at the moving rate even when still', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 0, accuracyM: 80 }), T0).send, true);
  assert.equal(gate.offer(fix({ at: 3_000, accuracyM: 12 }), T0 + 3_000).send, true);
});

test('an out-of-order cached fix is not sent', () => {
  const gate = new FixGate();
  assert.equal(gate.offer(fix({ at: 10_000 }), T0 + 10_000).send, true);
  assert.deepEqual(gate.offer(fix({ at: 0, point: north(50) }), T0 + 40_000), { send: false, reason: 'stale' });
});

test('the payload carries OwnTracks acc, cog and vel plus exact speed', () => {
  const body = ownTracksPayload({ point: BLR, accuracyM: 7.25, speedMps: 10, headingDeg: 91.6, ts: T0 + 999 }, 4, {
    battery: 81.4,
  });
  assert.equal(body._type, 'location');
  assert.equal(body.lat, BLR.lat);
  assert.equal(body.tst, Math.floor((T0 + 999) / 1000));
  assert.equal(body.acc, 7.3);
  assert.equal(body.cog, 92);
  assert.equal(body.vel, 36);
  assert.equal(body.speedMps, 10);
  assert.equal(body.batt, 81);
  assert.equal(body.seq, 4);
  // Unknowns are left out rather than sent as zeros the server would believe.
  const bare = ownTracksPayload({ point: BLR, speedMps: 0, ts: T0 }, 1);
  assert.equal(bare.acc, undefined);
  assert.equal(bare.cog, undefined);
  assert.equal(bare.batt, undefined);
});
