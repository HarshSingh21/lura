import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { afterLoad, readBasemap, readBasemapAsync, writeBasemap, writeBasemapAsync } from './basemapPrefs';
import type { BasemapId } from './types';

/**
 * The viewer's chosen basemap, remembered on this device.
 *
 * It is a per-viewer convenience, not account state: Harsh may want satellite on
 * his laptop and streets on his phone, and neither choice is worth a round trip
 * to the server. One small store backs every map so that switching on the live
 * map is already in effect when the history map opens.
 *
 * Web uses localStorage; native uses SecureStore, which is already in the build
 * for the session tokens (AsyncStorage is not, and a basemap name is a dozen
 * bytes). Both are wrapped so a private window or a locked keystore simply means
 * "streets" rather than an error.
 */

type BasemapState = {
  basemap: BasemapId;
  loaded: boolean;
  set: (basemap: BasemapId) => void;
};

const useBasemapStore = create<BasemapState>((set) => ({
  basemap: (Platform.OS === 'web' ? readBasemap() : undefined) ?? 'streets',
  loaded: Platform.OS === 'web',
  set: (basemap) => {
    set({ basemap, loaded: true });
    // Losing the preference costs one tap next launch; basemapPrefs swallows it.
    if (Platform.OS === 'web') writeBasemap(basemap);
    else void writeBasemapAsync(basemap, SecureStore.setItemAsync);
  },
}));

let nativeLoad: Promise<void> | null = null;

/** loadNative reads the stored choice once per app launch. */
function loadNative(): Promise<void> {
  if (nativeLoad) return nativeLoad;
  nativeLoad = (async () => {
    // Nothing stored, or a keystore that will not open: streets it is.
    const stored = await readBasemapAsync(SecureStore.getItemAsync);
    useBasemapStore.setState(afterLoad(stored, useBasemapStore.getState()));
  })();
  return nativeLoad;
}

/** useBasemap returns the viewer's basemap and a setter that persists it. */
export function useBasemap(): [BasemapId, (basemap: BasemapId) => void] {
  const basemap = useBasemapStore((s) => s.basemap);
  const set = useBasemapStore((s) => s.set);
  useEffect(() => {
    if (Platform.OS !== 'web') void loadNative();
  }, []);
  return [basemap, set];
}
