import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import '../../test/clientgeo.resolve.mts';

const { BASEMAP_KEY, afterLoad, readBasemap, readBasemapAsync, writeBasemap, writeBasemapAsync } = await import('./basemapPrefs.ts');

/** memory is a Storage stand-in. */
function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

const refusing = {
  getItem: (): string | null => {
    throw new Error('QuotaExceededError');
  },
  setItem: (): void => {
    throw new Error('QuotaExceededError');
  },
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).localStorage;
});

test('a basemap chosen once is read back on the next load', () => {
  const s = memory();
  assert.equal(writeBasemap('satellite', () => s), true);
  assert.equal(s.data.get(BASEMAP_KEY), 'satellite');
  assert.equal(readBasemap(() => s), 'satellite');
  // Every id round-trips.
  for (const id of ['streets', 'light', 'dark', 'satellite', 'hybrid', 'terrain'] as const) {
    writeBasemap(id, () => s);
    assert.equal(readBasemap(() => s), id);
  }
});

test('nothing stored, junk stored or no storage reads as nothing (the map falls back to streets)', () => {
  assert.equal(readBasemap(() => memory()), undefined);
  assert.equal(readBasemap(() => memory({ [BASEMAP_KEY]: 'mappls-night' })), undefined);
  assert.equal(readBasemap(() => memory({ [BASEMAP_KEY]: '' })), undefined);
  assert.equal(readBasemap(() => null), undefined);
});

test('storage that throws on read or write costs the preference, never an exception', () => {
  assert.doesNotThrow(() => readBasemap(() => refusing));
  assert.equal(readBasemap(() => refusing), undefined);
  assert.equal(writeBasemap('dark', () => refusing), false);
  // The accessor itself throwing (a blocked document) is caught too.
  const blocked = () => {
    throw new Error('SecurityError');
  };
  assert.equal(readBasemap(blocked), undefined);
  assert.equal(writeBasemap('dark', blocked), false);
});

test('regression: a browser that blocks site data loads the map instead of crashing at import', () => {
  // useBasemap used to guard with a bare `typeof localStorage` outside its
  // try/catch, at store creation: in such a browser the property read throws,
  // so importing any map took the app down. The default accessor is the page's
  // localStorage, read safely.
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: The operation is insecure.');
    },
  });
  assert.doesNotThrow(() => readBasemap());
  assert.equal(readBasemap(), undefined);
  assert.equal(writeBasemap('hybrid'), false);
});

test('the default accessor is the page localStorage', () => {
  const s = memory({ [BASEMAP_KEY]: 'terrain' });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: s });
  assert.equal(readBasemap(), 'terrain');
  assert.equal(writeBasemap('light'), true);
  assert.equal(s.data.get(BASEMAP_KEY), 'light');
});

test('native: a locked keystore reads as nothing and a refused write is swallowed', async () => {
  assert.equal(await readBasemapAsync(async () => 'hybrid'), 'hybrid');
  assert.equal(await readBasemapAsync(async () => null), undefined);
  assert.equal(await readBasemapAsync(async () => 'nonsense'), undefined);
  assert.equal(
    await readBasemapAsync(async () => {
      throw new Error('User interaction is not allowed');
    }),
    undefined,
  );
  const saved: string[] = [];
  assert.equal(await writeBasemapAsync('dark', async (k, v) => void saved.push(`${k}=${v}`)), true);
  assert.deepEqual(saved, [`${BASEMAP_KEY}=dark`]);
  assert.equal(
    await writeBasemapAsync('dark', async () => {
      throw new Error('keystore');
    }),
    false,
  );
});

test('native: a choice made while the stored one was loading wins over it', () => {
  // Stored satellite arrives before the viewer touched anything: it applies.
  assert.deepEqual(afterLoad('satellite', { basemap: 'streets', loaded: false }), { basemap: 'satellite', loaded: true });
  // The viewer picked dark while the read was in flight: dark stays.
  assert.deepEqual(afterLoad('satellite', { basemap: 'dark', loaded: true }), { basemap: 'dark', loaded: true });
  // Nothing stored: whatever is shown stays, and loading is over either way.
  assert.deepEqual(afterLoad(undefined, { basemap: 'streets', loaded: false }), { basemap: 'streets', loaded: true });
});
