// Session renewal scenarios: the pieces session.ts is built from (refresh.ts),
// composed into a fake session the way session.ts composes them, so the
// behaviour under test is the real policy rather than a re-statement of it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  freshToken,
  installRenewTriggers,
  renewAfterRejection,
  singleFlight,
  withSessionToken,
  type TokenSource,
} from './refresh.ts';

const MIN = 60_000;
const LIFE = 15 * MIN;

class Unauthorized extends Error {}
const isUnauthorized = (err: unknown) => err instanceof Unauthorized;

/**
 * fakeSession is session.ts with Keycloak replaced: `refreshCalls` counts the
 * token requests, each of which spends the refresh token (Keycloak rotates it)
 * and fails if handed one that was already spent.
 */
function fakeSession(opts: { now: () => number; expiresAt: number; latencyMs?: number }) {
  let generation = 1;
  const state: { accessToken?: string; refreshToken?: string; expiresAt?: number; status: string } = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: opts.expiresAt,
    status: 'signed-in',
  };
  const stats = { refreshCalls: 0, spentRefreshTokenReused: 0 };
  const spent = new Set<string>();
  const forced: { at?: number } = {};

  const flight = singleFlight(async () => {
    stats.refreshCalls++;
    const presented = state.refreshToken!;
    await new Promise((r) => setTimeout(r, opts.latencyMs ?? 5));
    if (spent.has(presented)) {
      stats.spentRefreshTokenReused++;
      state.status = 'signed-out';
      state.accessToken = state.refreshToken = undefined;
      return false;
    }
    spent.add(presented);
    generation++;
    state.accessToken = `access-${generation}`;
    state.refreshToken = `refresh-${generation}`;
    state.expiresAt = opts.now() + LIFE;
    return true;
  });
  const refresh = () => flight.current() ?? (state.refreshToken ? flight.run() : Promise.resolve(false));

  const source: TokenSource = {
    fresh: () => freshToken({ state: () => state, lifetimeMs: () => LIFE, refresh, now: opts.now }),
    renew: (rejected) =>
      renewAfterRejection(rejected, {
        current: () => state.accessToken,
        hasRefreshToken: () => !!state.refreshToken,
        inFlight: flight.current,
        refresh,
        now: opts.now,
        forced,
      }),
  };
  return { state, stats, source, refresh };
}

/** server accepts only the tokens `valid()` names, like Lura's verifier. */
function server(valid: () => Set<string>) {
  const seen: (string | undefined)[] = [];
  return {
    seen,
    send: async (token: string | undefined) => {
      seen.push(token);
      await new Promise((r) => setTimeout(r, 1));
      if (!token || !valid().has(token)) throw new Unauthorized('401');
      return 'ok';
    },
  };
}

test('a token outside its margin is used as is: no token request', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE });
  now = 5 * MIN;
  assert.equal(await s.source.fresh(), 'access-1');
  assert.equal(s.stats.refreshCalls, 0);
});

test('a token inside its last minute is renewed before it is sent', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE });
  now = LIFE - 30_000;
  assert.equal(await s.source.fresh(), 'access-2');
  assert.equal(s.stats.refreshCalls, 1);
});

test('twenty requests and a socket handshake that all find the token stale share one renewal', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE, latencyMs: 20 });
  now = LIFE + 10 * MIN; // back from a long sleep: the token is dead
  const api = server(() => new Set([s.state.accessToken!]));

  const calls = Array.from({ length: 20 }, () => withSessionToken(s.source, api.send, isUnauthorized));
  const handshake = s.source.fresh();
  const results = await Promise.all(calls);

  assert.deepEqual(results, Array(20).fill('ok'));
  assert.equal(await handshake, 'access-2');
  assert.equal(s.stats.refreshCalls, 1, 'one token request for the whole burst');
  assert.equal(s.stats.spentRefreshTokenReused, 0, 'no request presented a spent refresh token');
  assert.equal(s.state.status, 'signed-in');
  assert.ok(api.seen.every((t) => t === 'access-2'), `every request went out with the renewed token: ${api.seen}`);
});

test('a burst of 401s for a token that looked fresh retries each request once, after one renewal', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE, latencyMs: 10 });
  now = 2 * MIN; // fresh by the client's clock, but the server already refuses it (revoked, skewed clock)
  const api = server(() => new Set(s.state.accessToken === 'access-1' ? [] : [s.state.accessToken!]));

  const results = await Promise.all(Array.from({ length: 8 }, () => withSessionToken(s.source, api.send, isUnauthorized)));
  assert.deepEqual(results, Array(8).fill('ok'));
  assert.equal(s.stats.refreshCalls, 1);
  // Each request went out at most twice: once refused, once with the renewal.
  assert.equal(api.seen.length, 16);
  assert.equal(api.seen.filter((t) => t === 'access-1').length, 8);
});

test('a server that refuses every token gets one renewal and one retry each, not a loop', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE });
  now = MIN;
  const api = server(() => new Set());
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, () => withSessionToken(s.source, api.send, isUnauthorized)));
  assert.ok(outcomes.every((o) => o.status === 'rejected'));
  assert.equal(s.stats.refreshCalls, 1);
  assert.ok(api.seen.length <= 10, `${api.seen.length} requests for 5 calls`);
  // Ten seconds later another 401 still does not force another renewal for
  // the token that renewal produced.
  now += 5_000;
  await assert.rejects(withSessionToken(s.source, api.send, isUnauthorized));
  assert.equal(s.stats.refreshCalls, 1);
});

test('the flight is released after it settles, so the next expiry renews again', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE });
  now = LIFE;
  assert.equal(await s.source.fresh(), 'access-2');
  now = 2 * LIFE;
  assert.equal(await s.source.fresh(), 'access-3');
  assert.equal(s.stats.refreshCalls, 2);
});

test('singleFlight survives work that throws synchronously and does not wedge', async () => {
  let calls = 0;
  const flight = singleFlight<number>(() => {
    calls++;
    if (calls === 1) throw new Error('boom');
    return Promise.resolve(calls);
  });
  await assert.rejects(flight.run(), /boom/);
  assert.equal(flight.current(), undefined);
  assert.equal(await flight.run(), 2);
});

/** fakeTarget is just enough EventTarget for document/window. */
function fakeTarget<T extends object>(extra: T) {
  const listeners = new Map<string, Set<() => void>>();
  return Object.assign(extra, {
    addEventListener: (type: string, fn: () => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: () => void) => listeners.get(type)?.delete(fn),
    fire: (type: string) => listeners.get(type)?.forEach((fn) => fn()),
    count: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
  });
}

test('coming back to the tab, focusing it, coming online or waking the machine renews; a hidden tab does not', () => {
  const doc = fakeTarget({ visibilityState: 'hidden' });
  const win = fakeTarget({});
  let wake: ((ms: number) => void) | undefined;
  let signedIn = true;
  let renewals = 0;
  const uninstall = installRenewTriggers({
    document: doc,
    window: win,
    onWake: (fn) => {
      wake = fn;
      return () => (wake = undefined);
    },
    signedIn: () => signedIn,
    renew: () => renewals++,
  });

  doc.fire('visibilitychange'); // went hidden
  win.fire('focus'); // focus event while still hidden
  assert.equal(renewals, 0);

  doc.visibilityState = 'visible';
  doc.fire('visibilitychange');
  win.fire('focus');
  win.fire('online');
  assert.equal(renewals, 3);

  wake!(45 * MIN); // laptop lid opened
  assert.equal(renewals, 4);

  signedIn = false;
  doc.fire('visibilitychange');
  wake!(MIN);
  assert.equal(renewals, 4, 'nothing to renew once signed out');

  uninstall();
  assert.equal(doc.count() + win.count(), 0);
  assert.equal(wake, undefined);
});

test('on native (no document or window) only waking renews', () => {
  let wake: ((ms: number) => void) | undefined;
  let renewals = 0;
  installRenewTriggers({
    onWake: (fn) => {
      wake = fn;
      return () => {};
    },
    signedIn: () => true,
    renew: () => renewals++,
  });
  wake!(10 * MIN);
  assert.equal(renewals, 1);
});

test('waking after a sleep renews the dead token once and the next request carries it', async () => {
  let now = 0;
  const s = fakeSession({ now: () => now, expiresAt: LIFE });
  let wake: ((ms: number) => void) | undefined;
  const pending: Promise<unknown>[] = [];
  installRenewTriggers({
    onWake: (fn) => {
      wake = fn;
      return () => {};
    },
    signedIn: () => s.state.status === 'signed-in',
    renew: () => void pending.push(s.source.fresh()),
  });
  now = LIFE + 30 * MIN;
  wake!(30 * MIN);
  const api = server(() => new Set([s.state.accessToken!]));
  assert.equal(await withSessionToken(s.source, api.send, isUnauthorized), 'ok');
  await Promise.all(pending);
  assert.equal(s.stats.refreshCalls, 1);
  assert.deepEqual(api.seen, ['access-2']);
});
