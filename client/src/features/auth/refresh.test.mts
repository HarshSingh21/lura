import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  FORCED_RENEWAL_GAP_MS,
  isExpiring,
  MIN_REFRESH_DELAY_MS,
  refreshDelayMs,
  refreshMarginMs,
  REFRESH_MARGIN_MS,
  shouldForceRenewal,
  withDeadline,
  withSessionToken,
} from './refresh.ts';

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

class Unauthorized extends Error {}
const isUnauthorized = (err: unknown) => err instanceof Unauthorized;

/** source fakes the session: `fresh` hands out `tokens` in turn, `renew` the next one. */
function source(tokens: (string | undefined)[], renewTo?: string) {
  const calls = { fresh: 0, renew: [] as (string | undefined)[] };
  return {
    calls,
    src: {
      fresh: async () => tokens[Math.min(calls.fresh++, tokens.length - 1)],
      renew: async (rejected: string | undefined) => {
        calls.renew.push(rejected);
        return renewTo ?? rejected;
      },
    },
  };
}

test('a call with a good token goes out once, with the fresh token', async () => {
  const { src, calls } = source(['t1']);
  const sent: (string | undefined)[] = [];
  const out = await withSessionToken(src, async (t) => (sent.push(t), 'ok'), isUnauthorized);
  assert.equal(out, 'ok');
  assert.deepEqual(sent, ['t1']);
  assert.deepEqual(calls.renew, []);
});

test('a 401 renews and retries once with the renewed token', async () => {
  const { src, calls } = source(['dead'], 'alive');
  const sent: (string | undefined)[] = [];
  const out = await withSessionToken(
    src,
    async (t) => {
      sent.push(t);
      if (t === 'dead') throw new Unauthorized();
      return 'ok';
    },
    isUnauthorized,
  );
  assert.equal(out, 'ok');
  assert.deepEqual(sent, ['dead', 'alive']);
  assert.deepEqual(calls.renew, ['dead']);
});

test('a 401 that renewal cannot fix is thrown, not retried with the same token', async () => {
  const { src } = source(['dead']); // renew hands back the same token
  let sends = 0;
  await assert.rejects(
    withSessionToken(src, async () => {
      sends += 1;
      throw new Unauthorized();
    }, isUnauthorized),
    Unauthorized,
  );
  assert.equal(sends, 1);
});

test('a second 401 after the retry is the answer: no loop', async () => {
  const { src } = source(['dead'], 'also-dead');
  let sends = 0;
  await assert.rejects(
    withSessionToken(src, async () => {
      sends += 1;
      throw new Unauthorized();
    }, isUnauthorized),
    Unauthorized,
  );
  assert.equal(sends, 2);
});

test('other failures are not retried and never renew', async () => {
  const { src, calls } = source(['t1'], 't2');
  await assert.rejects(withSessionToken(src, async () => {
    throw new Error('offline');
  }, isUnauthorized), /offline/);
  assert.deepEqual(calls.renew, []);
});

test('a 401 forces a renewal only for the token in hand, and not twice in a row', () => {
  assert.equal(shouldForceRenewal('t1', 't1', undefined, NOW), true);
  // Someone already renewed: use theirs.
  assert.equal(shouldForceRenewal('t1', 't2', undefined, NOW), false);
  // Just forced one: a server refusing everything must not get a refresh per request.
  assert.equal(shouldForceRenewal('t1', 't1', NOW - 1000, NOW), false);
  assert.equal(shouldForceRenewal('t1', 't1', NOW - FORCED_RENEWAL_GAP_MS, NOW), true);
  // No token at all yet: renewing is the only way to get one.
  assert.equal(shouldForceRenewal(undefined, undefined, undefined, NOW), true);
});

test('a token request that never answers is abandoned at the deadline', async () => {
  await assert.rejects(withDeadline(new Promise(() => {}), 20, 'too slow'), /too slow/);
  assert.equal(await withDeadline(Promise.resolve(7), 1000), 7);
  await assert.rejects(withDeadline(Promise.reject(new Error('refused')), 1000), /refused/);
});
