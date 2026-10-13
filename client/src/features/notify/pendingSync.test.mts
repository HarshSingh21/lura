import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPendingSync } from './pendingSync.ts';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const state = { signedIn: true, fetches: 0, applied: [] as string[] };
  const pending: ReturnType<typeof deferred<string>>[] = [];
  const sync = createPendingSync<string>({
    allowed: () => state.signedIn,
    fetch: () => {
      state.fetches++;
      const d = deferred<string>();
      pending.push(d);
      return d.promise;
    },
    apply: (answer) => state.applied.push(answer),
    retryable: () => true,
  });
  return { state, pending, sync };
}

const tick = () => new Promise((r) => setImmediate(r));

test('a call during a read runs exactly one more read after it', async () => {
  const { state, pending, sync } = harness();
  const first = sync();
  void sync();
  void sync();
  await tick();
  assert.equal(state.fetches, 1);
  pending[0]!.resolve('a');
  await tick();
  assert.equal(state.fetches, 2);
  pending[1]!.resolve('b');
  await first;
  assert.deepEqual(state.applied, ['a', 'b']);
});

test('a read queued before signing out does not go out after it', async () => {
  const { state, pending, sync } = harness();
  const first = sync();
  void sync(); // the socket's hello, queued behind the first read
  await tick();
  state.signedIn = false; // Sign out, while the first read is in flight
  pending[0]!.resolve('a');
  await first;
  assert.equal(state.fetches, 1, 'no request without a session');
  assert.deepEqual(state.applied, [], 'an answer landing after sign-out is dropped');
});

test('no read at all while signed out', async () => {
  const { state, sync } = harness();
  state.signedIn = false;
  await sync();
  assert.equal(state.fetches, 0);
});

test('a later call after sign-in starts afresh', async () => {
  const { state, pending, sync } = harness();
  state.signedIn = false;
  await sync();
  state.signedIn = true;
  const p = sync();
  await tick();
  pending[0]!.resolve('x');
  await p;
  assert.deepEqual(state.applied, ['x']);
});

test('a failure that is not retryable stops the loop', async () => {
  let fetches = 0;
  const sync = createPendingSync<string>({
    allowed: () => true,
    fetch: async () => {
      fetches++;
      throw new Error('offline');
    },
    apply: () => {},
    retryable: () => false,
  });
  const p = sync();
  void sync();
  await p;
  assert.equal(fetches, 1);
});
