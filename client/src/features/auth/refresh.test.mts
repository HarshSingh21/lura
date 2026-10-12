import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isExpiring, MIN_REFRESH_DELAY_MS, refreshDelayMs, refreshMarginMs, REFRESH_MARGIN_MS } from './refresh.ts';

const NOW = 1_800_000_000_000;

test('a 15-minute token is renewed a minute before it expires', () => {
  const life = 15 * 60_000;
  assert.equal(refreshMarginMs(life), REFRESH_MARGIN_MS);
  assert.equal(refreshDelayMs(NOW + life, life, NOW), life - 60_000);
});

test('a 60 s token is renewed at 45 s, not every five seconds', () => {
  const life = 60_000;
  assert.equal(refreshDelayMs(NOW + life, life, NOW), 45_000);
  // Fresh from Keycloak it is not "expiring", so a socket handshake does not refresh again.
  assert.equal(isExpiring(NOW + life, life, NOW), false);
  assert.equal(isExpiring(NOW + life, life, NOW + 50_000), true);
});

test('an already-late token is renewed soon, but never in a tight loop', () => {
  assert.equal(refreshDelayMs(NOW - 1000, 60_000, NOW), MIN_REFRESH_DELAY_MS);
});

test('no expiry means expiring, and an unknown lifetime falls back to a minute', () => {
  assert.equal(isExpiring(undefined, 60_000, NOW), true);
  assert.equal(refreshMarginMs(Number.NaN), REFRESH_MARGIN_MS);
  assert.equal(refreshMarginMs(0), REFRESH_MARGIN_MS);
});
