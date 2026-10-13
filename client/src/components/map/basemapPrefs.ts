import { localStorageOrNull } from '../../state/webStorage';
import { isBasemapId } from './basemaps';
import type { BasemapId } from './types';

/**
 * Reading and writing the viewer's basemap choice (useBasemap.ts), with every
 * storage failure turned into "nothing stored".
 *
 * A private window, a browser blocking site data or a keystore that will not
 * open must cost the preference, never the map: the choice falls back to
 * streets, and a write that is refused is forgotten. Junk in storage (an old id,
 * someone else's key) reads as nothing stored too.
 *
 * Free of React Native so `node --test` runs it (basemapPrefs.clientgeo.test.mts).
 */

export const BASEMAP_KEY = 'lura.basemap';

/** The part of Storage this needs; localStorage on web. */
export type SyncStore = Pick<Storage, 'getItem' | 'setItem'>;

/** readBasemap reads a synchronous store; `store` is called inside the try, as it may throw. */
export function readBasemap(store: () => SyncStore | null = localStorageOrNull): BasemapId | undefined {
  try {
    const raw = store()?.getItem(BASEMAP_KEY);
    return isBasemapId(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** writeBasemap stores the choice, reporting whether it stuck. */
export function writeBasemap(basemap: BasemapId, store: () => SyncStore | null = localStorageOrNull): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(BASEMAP_KEY, basemap);
    return true;
  } catch {
    return false;
  }
}

/** readBasemapAsync is readBasemap for an asynchronous store (SecureStore on native). */
export async function readBasemapAsync(get: (key: string) => Promise<string | null>): Promise<BasemapId | undefined> {
  try {
    const raw = await get(BASEMAP_KEY);
    return isBasemapId(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** writeBasemapAsync is writeBasemap for an asynchronous store. */
export async function writeBasemapAsync(basemap: BasemapId, set: (key: string, value: string) => Promise<void>): Promise<boolean> {
  try {
    await set(BASEMAP_KEY, basemap);
    return true;
  } catch {
    return false;
  }
}

/**
 * afterLoad settles an asynchronous read against the live state: a choice the
 * viewer made while the read was in flight (`loaded` already true) wins over
 * the stored one, which is older by definition.
 */
export function afterLoad(
  stored: BasemapId | undefined,
  state: { basemap: BasemapId; loaded: boolean },
): { basemap: BasemapId; loaded: true } {
  return { basemap: !state.loaded && stored ? stored : state.basemap, loaded: true };
}
