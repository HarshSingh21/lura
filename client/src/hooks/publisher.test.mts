import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Publisher, type DeviceCredential, type PublisherDeps } from './publisher.ts';

type Call = { path: string; token?: string };

/** fakeServer accepts the static session only when `sessionOk`, and known device tokens always. */
function fakeServer(opts: { sessionOk: boolean; tokens?: string[]; stored?: DeviceCredential | null }) {
  const calls: Call[] = [];
  const tokens = new Set(opts.tokens ?? []);
  let stored = opts.stored ?? null;
  let registered = 0;
  const deps: PublisherDeps = {
    post: async (path, _body, token) => {
      calls.push({ path, token });
      if (token) {
        if (!tokens.has(token)) throw { status: 401 };
        return {};
      }
      if (!opts.sessionOk) throw { status: 401 };
      return {};
    },
    register: async () => {
      registered += 1;
      const cred = { deviceId: `dev_browser_${registered}`, token: `tok_${registered}` };
      tokens.add(cred.token);
      return cred;
    },
    load: async () => stored,
    save: async (cred) => {
      stored = cred;
    },
  };
  return { deps, calls, stored: () => stored, registered: () => registered, revoke: (t: string) => tokens.delete(t) };
}

test('static development token: publishes as the named device, registers nothing', async () => {
  const s = fakeServer({ sessionOk: true });
  const p = new Publisher(s.deps);
  assert.deepEqual(await p.publish({}, 'dev_phone'), { via: 'session', deviceId: 'dev_phone' });
  assert.equal(s.registered(), 0);
  assert.equal(s.calls[0]?.path, '/pub?device=dev_phone');
});

test('signed-in session: registers this browser once and reuses its token', async () => {
  const s = fakeServer({ sessionOk: false });
  const p = new Publisher(s.deps);
  const first = await p.publish({}, 'dev_phone');
  assert.equal(first.registered, true);
  assert.equal(first.via, 'device-token');
  assert.deepEqual(s.stored(), { deviceId: 'dev_browser_1', token: 'tok_1' });

  const before = s.calls.length;
  const second = await p.publish({}, 'dev_phone');
  assert.equal(second.via, 'device-token');
  assert.equal(second.registered, undefined);
  // One call: straight to /pub with the device token, no session retry.
  assert.deepEqual(s.calls.slice(before), [{ path: '/pub', token: 'tok_1' }]);
  assert.equal(s.registered(), 1);
});

test('a brand-new account with no devices registers immediately', async () => {
  const s = fakeServer({ sessionOk: false });
  const p = new Publisher(s.deps);
  const r = await p.publish({}, '');
  assert.equal(r.registered, true);
  assert.ok(s.calls.every((c) => c.path === '/pub'));
});

test('a stored credential survives a reload', async () => {
  const s = fakeServer({ sessionOk: false, tokens: ['tok_saved'], stored: { deviceId: 'dev_saved', token: 'tok_saved' } });
  const p = new Publisher(s.deps);
  assert.deepEqual(await p.publish({}, 'dev_phone'), { via: 'device-token', deviceId: 'dev_saved' });
  assert.equal(s.registered(), 0);
});

test('a revoked credential is dropped and replaced', async () => {
  const s = fakeServer({ sessionOk: false, tokens: [], stored: { deviceId: 'dev_gone', token: 'tok_gone' } });
  const p = new Publisher(s.deps);
  const r = await p.publish({}, 'dev_phone');
  assert.equal(r.registered, true);
  assert.notEqual(s.stored()?.token, 'tok_gone');
});

test('a server error is not mistaken for a refused credential', async () => {
  const s = fakeServer({ sessionOk: true });
  s.deps.post = async () => {
    throw { status: 503 };
  };
  const p = new Publisher(s.deps);
  await assert.rejects(p.publish({}, 'dev_phone'));
  assert.equal(s.registered(), 0);
});
