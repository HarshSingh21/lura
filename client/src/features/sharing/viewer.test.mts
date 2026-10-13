import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Position } from '../../api/types.ts';
import { acceptFix, describeDuration, describeEnding, shareEnded } from './viewer.ts';

const fix = (over: Partial<Position> = {}): Position => ({
  deviceId: 'dev_1',
  userId: 'u_harsh',
  recvTs: '2026-10-13T08:00:10Z',
  deviceTs: '2026-10-13T08:00:10Z',
  point: { lat: 12.97, lon: 77.64 },
  accuracyM: 5,
  speedMps: 4,
  altitudeM: 0,
  headingDeg: 0,
  battery: 80,
  seq: 0,
  ...over,
});

test('an arrival names the person and the place', () => {
  const n = shareEnded({ reason: 'arrived at Office', sharerName: 'Harsh Singh' });
  assert.equal(n.title, 'This share has ended');
  assert.equal(n.body, 'Harsh arrived at Office, so the link switched itself off.');
});

test('expiry and revocation read as sentences, not reason codes', () => {
  assert.match(shareEnded({ reason: 'expired', sharerName: 'Harsh' }).body, /time ran out/);
  assert.match(shareEnded({ reason: 'revoked by owner', sharerName: 'Harsh Singh' }).body, /^Harsh stopped sharing\./);
  assert.match(shareEnded({ reason: 'revoked by owner' }).body, /^The sharer stopped sharing\./);
  assert.equal(shareEnded({ reason: 'device lost' }).body, 'Device lost.');
});

test('an unknown link is not called an ended share', () => {
  const n = shareEnded({ status: 404 });
  assert.equal(n.title, 'This link does not work');
  assert.equal(n.ended, false);
  assert.equal(shareEnded({ status: 403 }).title, 'This share has ended');
});

test('the countdown never promises time that is not there', () => {
  assert.equal(describeDuration(30 * 60_000), '30 min');
  assert.equal(describeDuration(30 * 60_000 - 1500), '30 min');
  assert.equal(describeDuration(59_000), 'under a minute');
  assert.equal(describeDuration(90 * 60_000), '1 h 30 min');
  assert.equal(describeDuration(120 * 60_000), '2 h');
  const now = Date.parse('2026-10-13T08:00:00Z');
  assert.match(describeEnding('duration', '2026-10-13T08:30:00Z', undefined, now), /^Ends in 30 min · /);
  assert.equal(describeEnding('duration', '2026-10-13T07:59:00Z', undefined, now), 'This link has expired');
  assert.equal(describeEnding('until_arrive', undefined, 'Office', now), 'Sharing until they arrive at Office');
});

test('a late or older fix never moves the dot backwards', () => {
  const shown = fix({ fixTs: '2026-10-13T08:00:10Z' });
  assert.equal(acceptFix(undefined, fix()), true);
  assert.equal(acceptFix(shown, fix({ recvTs: '2026-10-13T08:00:12Z', fixTs: '2026-10-13T08:00:12Z' })), true);
  assert.equal(acceptFix(shown, fix({ recvTs: '2026-10-13T08:00:12Z', fixTs: '2026-10-13T07:58:00Z' })), false);
  assert.equal(acceptFix(undefined, fix({ late: true })), false);
});
