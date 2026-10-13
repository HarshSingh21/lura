import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { localStorageOrNull } from './webStorage.ts';

const g = globalThis as Record<string, unknown>;
afterEach(() => {
  delete g.localStorage;
});

test('no storage at all (native, prerender) is null, not an error', () => {
  // Node 25 has a localStorage of its own; take it away as native would.
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
  assert.equal(localStorageOrNull(), null);
});

test('a browser that blocks site data throws on the read itself, and that is null too', () => {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: The operation is insecure.');
    },
  });
  // The bare guard the app used to rely on does throw here...
  assert.throws(() => typeof localStorage);
  // ...the accessor does not.
  assert.equal(localStorageOrNull(), null);
});

test('a working storage is returned as is', () => {
  const store = { getItem: () => null, setItem: () => undefined };
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: store });
  assert.equal(localStorageOrNull(), store);
});
