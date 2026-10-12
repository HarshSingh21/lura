import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { color } from '@/theme/tokens';

import { mapplsStyleFor, mapplsStyleNames } from './basemaps';
import { absoluteFill } from './fill';
import { FenceOverlay, MarkerOverlay, TrackOverlay } from './Overlays';
import { FenceEditor } from './FenceEditor';
import type { Viewport } from './projection';
import type { BasemapId, MapViewProps } from './types';

/**
 * Mappls Web Maps (v3) on the web, when the server opts into Mappls.
 *
 * The Mappls map is used as a basemap and nothing more: fences, tracks and
 * markers are the shared screen-space overlays, positioned from the viewport this
 * component mirrors out of the map. That keeps the surface of a proprietary,
 * loosely typed SDK down to "make a map, tell me where it is, tell me where it was
 * tapped" — and keeps Lura's drawing identical across every provider.
 *
 * The SDK is loaded from Mappls' CDN with a plain script tag, which is all the
 * `mappls-web-maps` npm package does; adding that package would put an
 * obfuscated loader in the bundle for one line of URL building.
 *
 * Anything that goes wrong — the script fails, the key is rejected, the map never
 * reports loaded — calls `onFail`, and the caller swaps in the MapLibre renderer.
 * A Mappls outage must not take the map away.
 */

/** How long a map may take to report `load` before it is treated as failed. */
const LOAD_TIMEOUT_MS = 15_000;

/** The slice of the Mappls Map object this renderer relies on. */
type MapplsMapObject = {
  on?: (event: string, handler: (e?: unknown) => void) => void;
  addListener?: (event: string, handler: (e?: unknown) => void) => void;
  getCenter: () => { lat: number; lng: number };
  getZoom: () => number;
  easeTo?: (options: { center?: [number, number]; zoom?: number; duration?: number; easing?: (t: number) => number }) => void;
  setCenter?: (center: { lat: number; lng: number }) => void;
  setZoom?: (zoom: number) => void;
  setStyle?: (name: string) => void;
  getStyles?: () => unknown;
  remove?: () => void;
};

type MapplsGlobal = {
  Map: new (id: string, options: Record<string, unknown>) => MapplsMapObject;
  getStyles?: () => unknown;
};

declare global {
  interface Window {
    mappls?: MapplsGlobal;
    __luraMapplsReady?: () => void;
  }
}

let sdk: { key: string; promise: Promise<MapplsGlobal> } | null = null;

/**
 * loadMapplsSdk injects the SDK script once per key and resolves when
 * `window.mappls.Map` exists.
 *
 * The SDK may finish initialising after the script's own load event, so both the
 * `callback` hook and `onload` are watched, and whichever sees a usable global
 * first wins.
 */
function loadMapplsSdk(key: string): Promise<MapplsGlobal> {
  if (sdk && sdk.key === key) return sdk.promise;
  const promise = new Promise<MapplsGlobal>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(new Error('no document'));
      return;
    }
    const ready = () => {
      if (window.mappls?.Map) resolve(window.mappls);
    };
    const timer = setTimeout(() => reject(new Error('Mappls SDK did not initialise')), LOAD_TIMEOUT_MS);
    window.__luraMapplsReady = () => {
      clearTimeout(timer);
      ready();
    };
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src =
      'https://sdk.mappls.com/map/sdk/web?v=3.0' +
      `&access_token=${encodeURIComponent(key)}` +
      '&callback=__luraMapplsReady';
    script.onload = () => {
      if (window.mappls?.Map) {
        clearTimeout(timer);
        resolve(window.mappls);
      }
    };
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Mappls SDK script failed to load'));
    };
    document.head.appendChild(script);
  });
  // A failed load is not cached: the next mount (or a corrected key) retries.
  promise.catch(() => {
    if (sdk?.promise === promise) sdk = null;
  });
  sdk = { key, promise };
  return promise;
}

let nextId = 0;

/** listen attaches a handler with whichever event API this SDK build exposes. */
function listen(map: MapplsMapObject, event: string, handler: (e?: unknown) => void) {
  if (typeof map.on === 'function') map.on(event, handler);
  else map.addListener?.(event, handler);
}

/**
 * styleNamesOf asks the SDK which styles this key may use. Builds differ on
 * where the list lives (the global or the map) and on whether it is returned
 * or resolved, so every shape is accepted and anything unexpected is "none".
 */
async function styleNamesOf(mappls: MapplsGlobal, map: MapplsMapObject): Promise<string[]> {
  for (const read of [() => mappls.getStyles?.(), () => map.getStyles?.()]) {
    try {
      const raw = await Promise.resolve(read());
      const names = mapplsStyleNames(raw);
      if (names.length > 0) return names;
    } catch {
      // This build does not have it here; try the next place.
    }
  }
  return [];
}

/** moveTo recentres and/or zooms with an animation when the SDK supports one. */
function moveTo(
  map: MapplsMapObject,
  center: { lat: number; lon: number } | null,
  zoom: number | null,
  duration: number,
  linear = false,
) {
  try {
    if (typeof map.easeTo === 'function') {
      map.easeTo({
        ...(center ? { center: [center.lon, center.lat] as [number, number] } : {}),
        ...(zoom !== null ? { zoom } : {}),
        duration,
        ...(linear ? { easing: (t: number) => t } : {}),
      });
      return;
    }
    if (center) map.setCenter?.({ lat: center.lat, lng: center.lon });
    if (zoom !== null) map.setZoom?.(zoom);
  } catch {
    // A map that has died mid-animation is handled by the error path.
  }
}

export function MapplsWebMap(
  props: MapViewProps & {
    apiKey: string;
    onFail: () => void;
    /** Mappls has no style for this basemap under this key; the caller draws it with MapLibre. */
    onBasemapUnsupported?: (basemap: BasemapId) => void;
  },
) {
  const {
    apiKey,
    onFail,
    onBasemapUnsupported,
    basemap = 'streets',
    followMs,
    center,
    zoom = 14,
    fences = [],
    markers = [],
    tracks = [],
    interactive = true,
    onPressMap,
    onPressFence,
    variant = 'light',
    recenterKey,
    onViewportChange,
    fenceEdit,
    onFenceGeometry,
  } = props;

  const dark = variant === 'dark';
  const [hostId] = useState(() => `lura-mappls-${(nextId += 1)}`);
  const hostRef = useRef<View | null>(null);
  const mapRef = useRef<MapplsMapObject | null>(null);
  const userMoved = useRef(false);
  const appliedZoom = useRef(zoom);
  // Held in refs so a new callback does not tear down the map.
  const viewportListener = useRef(onViewportChange);
  const pressListener = useRef(onPressMap);
  const failListener = useRef(onFail);
  const unsupportedListener = useRef(onBasemapUnsupported);
  const basemapRef = useRef(basemap);
  // Filled once the map has loaded: the style names this key can use.
  const styleNames = useRef<string[] | null>(null);
  const appliedStyle = useRef<string | null>(null);
  useEffect(() => {
    viewportListener.current = onViewportChange;
    pressListener.current = onPressMap;
    failListener.current = onFail;
    unsupportedListener.current = onBasemapUnsupported;
    basemapRef.current = basemap;
  });
  const [view, setView] = useState<Viewport>({ center, zoom, width: 0, height: 0 });

  /**
   * applyBasemap switches the Mappls style, or reports that there is none for
   * this basemap so MapLibre can take over. Streets with no matching name is the
   * SDK's own default and needs nothing.
   */
  const applyBasemap = (map: MapplsMapObject, wanted: BasemapId) => {
    const names = styleNames.current;
    if (!names) return; // not loaded yet; the load handler calls this again
    const name = mapplsStyleFor(wanted, names);
    if (!name) {
      if (wanted !== 'streets') unsupportedListener.current?.(wanted);
      return;
    }
    if (appliedStyle.current === name) return;
    try {
      map.setStyle?.(name);
      appliedStyle.current = name;
    } catch {
      if (wanted !== 'streets') unsupportedListener.current?.(wanted);
    }
  };

  // ---- create the map once per key
  useEffect(() => {
    let cancelled = false;
    let map: MapplsMapObject | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | undefined;

    const fail = () => {
      if (cancelled) return;
      cancelled = true;
      mapRef.current = null;
      failListener.current();
    };

    loadMapplsSdk(apiKey)
      .then((mappls) => {
        if (cancelled) return;
        const node = hostRef.current as unknown as HTMLDivElement | null;
        if (!node) return;

        map = new mappls.Map(hostId, {
          center: { lat: center.lat, lng: center.lon },
          zoom,
          zoomControl: false,
          location: false,
          // Rotation and tilt make a geofence circle unreadable, as on MapLibre.
          rotateControl: false,
          pitchWithRotate: false,
          dragRotate: false,
          draggable: interactive,
          scrollWheel: interactive,
          doubleClickZoom: interactive,
        });
        mapRef.current = map;
        const live = map;

        const syncView = () => {
          if (cancelled) return;
          try {
            const c = live.getCenter();
            const next = {
              center: { lat: c.lat, lon: c.lng },
              zoom: live.getZoom(),
              width: node.clientWidth,
              height: node.clientHeight,
            };
            setView(next);
            viewportListener.current?.(next);
          } catch {
            // getCenter on a torn-down map; the next event or the cleanup wins.
          }
        };

        loadTimer = setTimeout(fail, LOAD_TIMEOUT_MS);
        listen(live, 'load', () => {
          clearTimeout(loadTimer);
          syncView();
          void styleNamesOf(mappls, live).then((names) => {
            if (cancelled) return;
            styleNames.current = names;
            applyBasemap(live, basemapRef.current);
          });
        });
        listen(live, 'move', syncView);
        listen(live, 'resize', syncView);
        listen(live, 'dragstart', () => {
          userMoved.current = true;
        });
        listen(live, 'zoomstart', () => {
          userMoved.current = true;
        });
        listen(live, 'click', (event) => {
          const lngLat = (event as { lngLat?: { lat: number; lng: number } } | undefined)?.lngLat;
          if (lngLat && pressListener.current) pressListener.current({ lat: lngLat.lat, lon: lngLat.lng });
        });
        listen(live, 'error', (event) => {
          // Auth and style failures are fatal; a single missing tile is not.
          const message = String((event as { error?: { message?: string } } | undefined)?.error?.message ?? '');
          if (/auth|token|key|licen|style|40[13]/i.test(message)) fail();
        });
      })
      .catch(fail);

    return () => {
      cancelled = true;
      clearTimeout(loadTimer);
      mapRef.current = null;
      try {
        map?.remove?.();
      } catch {
        // A map that never finished initialising throws from remove(); nothing to clean.
      }
    };
    // The map is created once per key; prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, hostId, interactive]);

  // ---- basemap switch
  useEffect(() => {
    const map = mapRef.current;
    if (map) applyBasemap(map, basemap);
  }, [basemap]);

  // ---- follow the centre until the user takes over (or always, in follow mode)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (followMs !== undefined) {
      moveTo(map, center, null, followMs, true);
      return;
    }
    if (userMoved.current) return;
    moveTo(map, center, null, 400);
  }, [center.lat, center.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- zoom controls: apply an explicit zoom without disturbing the centre
  useEffect(() => {
    if (Math.abs(appliedZoom.current - zoom) < 0.01) return;
    appliedZoom.current = zoom;
    const map = mapRef.current;
    if (map) moveTo(map, null, zoom, 250);
  }, [zoom]);

  // ---- explicit recentre ("locate me" button) always wins
  useEffect(() => {
    if (recenterKey === undefined) return;
    userMoved.current = false;
    const map = mapRef.current;
    if (map) moveTo(map, center, zoom, 500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);

  return (
    <View style={styles.container}>
      <View ref={hostRef} nativeID={hostId} style={styles.map} />
      {/* Overlays sit above the map and must not swallow its gestures. */}
      <View style={styles.overlays} pointerEvents="box-none">
        <TrackOverlay tracks={tracks} view={view} dark={dark} />
        <FenceOverlay fences={fences} view={view} dark={dark} onPress={onPressFence} />
        <MarkerOverlay markers={markers} view={view} dark={dark} />
        {fenceEdit && onFenceGeometry ? (
          <FenceEditor state={fenceEdit} view={view} onGeometry={onFenceGeometry} dark={dark} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: color.mapBg },
  map: { flex: 1 },
  overlays: absoluteFill,
});
