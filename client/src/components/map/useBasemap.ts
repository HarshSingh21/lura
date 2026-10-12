import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { isBasemapId } from './basemaps';
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

const KEY = 'lura.basemap';

type BasemapState = {
  basemap: BasemapId;
  loaded: boolean;
  set: (basemap: BasemapId) => void;
};

const useBasemapStore = create<BasemapState>((set) => ({
  basemap: readWebSync() ?? 'streets',
  loaded: Platform.OS === 'web',
  set: (basemap) => {
    set({ basemap, loaded: true });
    void write(basemap);
  },
}));

function readWebSync(): BasemapId | undefined {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(KEY);
    return isBasemapId(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function write(basemap: BasemapId): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, basemap);
    } catch {
      // A private-mode browser refusing storage is not worth failing over.
    }
    return;
  }
  try {
    await SecureStore.setItemAsync(KEY, basemap);
  } catch {
    // Losing the preference costs one tap next launch.
  }
}

let nativeLoad: Promise<void> | null = null;

/** loadNative reads the stored choice once per app launch. */
function loadNative(): Promise<void> {
  if (nativeLoad) return nativeLoad;
  nativeLoad = (async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      // A choice made while the read was in flight wins over the stored one.
      if (isBasemapId(raw) && !useBasemapStore.getState().loaded) {
        useBasemapStore.setState({ basemap: raw });
      }
    } catch {
      // Nothing stored, or a keystore that will not open: streets it is.
    }
    useBasemapStore.setState({ loaded: true });
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
