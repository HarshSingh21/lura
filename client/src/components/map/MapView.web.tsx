// Metro bundles CSS imports for web, so MapLibre's stylesheet becomes part of the
// output bundle — a local asset, not a CDN request, which is what airgap mode
// requires. Without it the GL canvas is mis-sized and the controls are unstyled.
import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  setWorkerUrl,
  Map as MapLibreMap,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type LngLatLike,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';

import { color, palette } from '@/theme/tokens';

import { maplibreStyle } from './basemaps';
import { absoluteFill } from './fill';
import { FenceOverlay, fenceRing, hasPolygon, MarkerOverlay } from './Overlays';
import { MapCanvas } from './MapCanvas';
import { MapplsWebMap } from './MapplsMap.web';
import type { Viewport } from './projection';
import type { BasemapId, MapFence, MapTrack, MapViewProps } from './types';

/**
 * MapLibre GL JS on the web (HLD §13).
 *
 * Four deliberate choices:
 *
 *   - Fences and tracks are GL layers (they must be in map space, in metres),
 *     while marker pills stay React views (they must match the mock's design).
 *     The viewport is mirrored into React state on every move so the two agree.
 *   - A basemap that fails to load falls back to the locally drawn canvas rather
 *     than leaving a blank rectangle: self-hosted tiles may be down, and the map
 *     is still useful with fences and positions on a plain ground.
 *   - Airgap mode never constructs a GL map at all, because the style URL is a
 *     network call and the promise is that there are none.
 *   - The worker URL is pinned. MapLibre parses vector tiles in a Web Worker
 *     loaded as a sibling ES module of whatever bundle contains MapLibre. Metro
 *     inlines MapLibre into the app bundle and never emits that chunk, so the
 *     request 404s and the map ends up with a style, sprites and no tiles at all
 *     — a blank basemap with everything drawn on top of it still working. Pinning
 *     the URL to a file served from public/ makes it independent of how the
 *     bundler names its output.
 *   - No WebGL2, no GL map. MapLibre requires WebGL2 and reports its absence
 *     *asynchronously*, after the constructor returns — so it is probed up front
 *     and the failure path is also handled on the error event. Machines with a
 *     blocked or missing GPU (locked-down laptops, VMs, headless CI) then get the
 *     canvas renderer instead of a blank page.
 */

/**
 * pinWorkerUrl points MapLibre at the worker chunk that
 * scripts/copy-maplibre-worker.mjs puts in public/.
 *
 * The subtlety is what to resolve it *against*. `document.baseURI` is the current
 * URL when the page has no `<base>` element, so on a nested route like
 * `/share/<token>` the worker would be looked for at
 * `/share/maplibre-gl-worker.mjs`, 404, and the map would end up with a style,
 * sprites and no tiles at all — a blank basemap with the markers still drawn on
 * top of it, which reads as "I can't see anything". The app root is therefore the
 * origin, unless the document declares a base (which is how a sub-path deployment
 * announces its root, and what `experiments.baseUrl` emits).
 */
function workerBase(): string {
  if (document.querySelector('base[href]')) return document.baseURI;
  return new URL('/', window.location.href).href;
}

function pinWorkerUrl() {
  if (typeof document === 'undefined') return;
  try {
    setWorkerUrl(new URL('maplibre-gl-worker.mjs', workerBase()).href);
  } catch {
    // A MapLibre build without setWorkerUrl resolves the worker itself.
  }
}

pinWorkerUrl();

/** hasWebGL2 probes for the context MapLibre needs before one is created. */
function hasWebGL2(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return canvas.getContext('webgl2') !== null;
  } catch {
    return false;
  }
}

/**
 * fatalMapError reports whether an error event means the map will never work.
 *
 * An event that names a source or tile is one tile failing — an imagery server
 * without coverage at this zoom, a dropped request — and the rest of the map is
 * fine; only errors about the map itself (GPU, style) are fatal.
 */
function fatalMapError(message: string, event?: { sourceId?: unknown; tile?: unknown }): boolean {
  if (event && (event.sourceId !== undefined || event.tile !== undefined)) return false;
  return (
    message.includes('WebGL') ||
    message.includes('GPUInitializationError') ||
    message.includes('style') ||
    message.includes('Failed to fetch')
  );
}

/**
 * MapView picks the web renderer.
 *
 * Mappls is used only when the server asked for it, handed out a key, and this
 * is not airgap; if it fails to come up, the MapLibre renderer takes over for the
 * rest of the page's life rather than retrying into a broken map.
 *
 * A basemap Mappls has no style for (its catalogue varies by key — satellite is
 * not on every plan) is drawn by MapLibre instead, for as long as it is chosen:
 * picking "satellite" must show satellite, whichever provider the server prefers.
 */
export function MapView(props: MapViewProps) {
  const [mapplsFailedFor, setMapplsFailedFor] = useState<string | null>(null);
  const [mapplsCannot, setMapplsCannot] = useState<BasemapId[]>([]);
  const key = props.mapplsKey;
  const basemap = props.basemap ?? 'streets';
  if (
    !props.offline &&
    props.provider === 'mappls' &&
    key &&
    mapplsFailedFor !== key &&
    !mapplsCannot.includes(basemap)
  ) {
    return (
      <MapplsWebMap
        {...props}
        apiKey={key}
        onFail={() => setMapplsFailedFor(key)}
        onBasemapUnsupported={(b) => setMapplsCannot((list) => (list.includes(b) ? list : [...list, b]))}
      />
    );
  }
  return <MapLibreWebMap {...props} />;
}

function MapLibreWebMap(props: MapViewProps) {
  const {
    center,
    zoom = 14,
    fences = [],
    markers = [],
    tracks = [],
    styleUrl,
    basemap,
    offline,
    interactive = true,
    onPressMap,
    onPressFence,
    variant = 'light',
    recenterKey,
    followMs,
    onViewportChange,
  } = props;

  const dark = variant === 'dark';
  const hostRef = useRef<View | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const userMoved = useRef(false);
  // Held in refs so changing a callback or the data does not tear down the map,
  // and so a style swap can re-add the newest fences and tracks.
  const viewportListener = useRef(onViewportChange);
  const latest = useRef({ fences, tracks, onPressFence });
  const appliedZoom = useRef(zoom);
  // Probed once per mount: the answer cannot change while the page is open.
  const [failed, setFailed] = useState(() => !hasWebGL2());
  const [view, setView] = useState<Viewport>({ center, zoom, width: 0, height: 0 });

  // The chosen basemap resolved to a style. Memoised so an inline raster style
  // keeps its identity between renders and is only applied when it changes.
  const style = useMemo(() => maplibreStyle(basemap, styleUrl) ?? fallbackStyle(dark), [basemap, styleUrl, dark]);
  const styleRef = useRef(style);
  const appliedStyle = useRef<typeof style | null>(null);

  useEffect(() => {
    viewportListener.current = onViewportChange;
    latest.current = { fences, tracks, onPressFence };
    styleRef.current = style;
  });

  // ---- create the map once
  useEffect(() => {
    if (offline || failed) return;
    const node = hostRef.current as unknown as HTMLDivElement | null;
    if (!node) return;

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: node,
        style: styleRef.current,
        center: [center.lon, center.lat],
        zoom,
        attributionControl: false,
        interactive,
        // The map is a backdrop, not a game: a short fade keeps label swaps calm
        // without paying for extra frames.
        fadeDuration: 120,
      });
    } catch {
      // Deferred a microtask so the fallback renders as a fresh update rather
      // than a cascade inside this effect.
      void Promise.resolve().then(() => setFailed(true));
      return;
    }
    mapRef.current = map;
    appliedStyle.current = styleRef.current;

    const syncView = () => {
      const c = map.getCenter();
      const canvas = map.getCanvas();
      const next = {
        center: { lat: c.lat, lon: c.lng },
        zoom: map.getZoom(),
        width: canvas.clientWidth,
        height: canvas.clientHeight,
      };
      setView(next);
      viewportListener.current?.(next);
    };

    // `style.load` fires for the first style and again after every setStyle,
    // which wipes custom sources and layers — so this is where Lura's fence and
    // track layers are (re-)added, filled with the newest data.
    map.on('style.load', () => {
      withMap(map, (m) => {
        installLayers(m, dark);
        updateSources(m, latest.current.fences, latest.current.tracks);
      });
    });
    map.on('load', syncView);
    map.on('move', syncView);
    map.on('resize', syncView);
    map.on('dragstart', () => {
      userMoved.current = true;
    });
    map.on('zoomstart', (event) => {
      // Only a person zooming counts; an easeTo carrying a zoom is not them.
      if ((event as { originalEvent?: unknown }).originalEvent) userMoved.current = true;
    });
    // Polygon fences are tapped through their GL fill (see FenceOverlay):
    // circles have screen-space tap targets above the canvas already.
    map.on('click', (event: MapMouseEvent) => {
      const press = latest.current.onPressFence;
      if (!press) return;
      withMap(map, (m) => {
        if (!m.getLayer(FENCE_FILL)) return;
        const hit = m
          .queryRenderedFeatures(event.point, { layers: [FENCE_FILL] })
          .find((f) => f.properties?.shape === 'polygon');
        const id = hit?.properties?.id;
        if (typeof id === 'string') press(id);
      });
    });
    map.on('error', (event) => {
      // A missing tile is survivable; a missing GPU or an unloadable style is not.
      const ev = event as { error?: { message?: string; name?: string }; sourceId?: unknown; tile?: unknown };
      const message = `${ev.error?.name ?? ''} ${ev.error?.message ?? ''}`;
      if (fatalMapError(message, ev)) {
        mapRef.current = null; // stop every imperative call below from touching it
        setFailed(true);
      }
    });

    return () => {
      mapRef.current = null;
      try {
        map.remove();
      } catch {
        // A map that failed to initialise throws from remove() too; there is
        // nothing left to clean up and nothing useful to report.
      }
    };
    // The map is created once; prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offline, failed, dark, interactive]);

  // ---- basemap switch: swap the style, keep the camera and Lura's layers
  useEffect(() => {
    withMap(mapRef.current, (map) => {
      if (appliedStyle.current === style) return;
      appliedStyle.current = style;
      // diff:false — a raster style and a vector style share nothing worth
      // diffing, and a full swap guarantees the style.load re-install runs.
      map.setStyle(style, { diff: false });
    });
  }, [style]);

  // ---- taps (drawing a place)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !onPressMap) return;
    const handler = (event: MapMouseEvent) => {
      onPressMap({ lat: event.lngLat.lat, lon: event.lngLat.lng });
    };
    map.on('click', handler);
    return () => {
      map.off('click', handler);
    };
  }, [onPressMap]);

  // ---- follow the centre until the user takes over (or always, in follow mode)
  useEffect(() => {
    withMap(mapRef.current, (map) => {
      if (followMs !== undefined) {
        // Follow mode: the camera moves at the marker's pace, linearly, so the
        // followed person stays put on screen while the city slides past.
        map.easeTo({ center: [center.lon, center.lat] as LngLatLike, duration: followMs, easing: linear });
        return;
      }
      if (userMoved.current) return;
      map.easeTo({ center: [center.lon, center.lat] as LngLatLike, duration: 400 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lon]);

  // ---- zoom controls: apply an explicit zoom without disturbing the centre
  useEffect(() => {
    if (Math.abs(appliedZoom.current - zoom) < 0.01) return;
    appliedZoom.current = zoom;
    withMap(mapRef.current, (map) => map.easeTo({ zoom, duration: 250 }));
  }, [zoom]);

  // ---- explicit recentre ("locate me" button) always wins
  useEffect(() => {
    if (recenterKey === undefined) return;
    userMoved.current = false;
    withMap(mapRef.current, (map) =>
      map.easeTo({ center: [center.lon, center.lat] as LngLatLike, zoom, duration: 500 }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recenterKey]);

  // ---- push fence/track geometry into the GL sources
  useEffect(() => {
    // Before the style has loaded (first load, or mid-swap) the style.load
    // handler applies the newest data itself.
    withMap(mapRef.current, (map) => updateSources(map, fences, tracks));
  }, [fences, tracks]);

  if (offline || failed) {
    return <MapCanvas {...props} />;
  }

  return (
    <View style={styles.container}>
      <View ref={hostRef} style={styles.gl} />
      {/* Overlays sit above the canvas and must not swallow map gestures. */}
      <View style={styles.overlays} pointerEvents="box-none">
        <FenceOverlay fences={fences} view={view} dark={dark} onPress={onPressFence} glShapes />
        <MarkerOverlay markers={markers} view={view} dark={dark} />
      </View>
    </View>
  );
}

const linear = (t: number) => t;

/**
 * withMap runs fn against a live map, swallowing the throw from a map whose GL
 * context died. MapLibre's imperative API assumes a healthy instance, and a
 * rejected easeTo must not take a React commit down with it.
 */
function withMap(map: MapLibreMap | null, fn: (map: MapLibreMap) => void) {
  if (!map) return;
  try {
    fn(map);
  } catch {
    // The map is unusable; the error event has already triggered the fallback.
  }
}

const FENCE_FILL = 'lura-fence-fill';
const FENCE_LINE = 'lura-fence-line';
const TRACK_LINE = 'lura-track-line';
const FENCE_SOURCE = 'lura-fences';
const TRACK_SOURCE = 'lura-tracks';

function installLayers(map: MapLibreMap, dark: boolean) {
  if (!map.getSource(FENCE_SOURCE)) {
    map.addSource(FENCE_SOURCE, { type: 'geojson', data: emptyCollection() });
  }
  if (!map.getSource(TRACK_SOURCE)) {
    map.addSource(TRACK_SOURCE, { type: 'geojson', data: emptyCollection() });
  }

  if (!map.getLayer(TRACK_LINE)) {
    map.addLayer({
      id: TRACK_LINE,
      type: 'line',
      source: TRACK_SOURCE,
      paint: {
        'line-color': ['coalesce', ['get', 'color'], dark ? palette.accentBright : palette.accentDark],
        'line-width': ['coalesce', ['get', 'width'], 4],
        // A dotted line reads as "inferred"; the dash array is set per feature.
        'line-dasharray': ['case', ['==', ['get', 'dotted'], true], ['literal', [0.2, 2]], ['literal', [1, 0]]],
      },
      layout: { 'line-cap': 'round', 'line-join': 'round' },
    });
  }

  // Fences are drawn under the track so a trip through a place stays visible.
  if (!map.getLayer(FENCE_FILL)) {
    map.addLayer(
      {
        id: FENCE_FILL,
        type: 'fill',
        source: FENCE_SOURCE,
        paint: {
          'fill-color': ['coalesce', ['get', 'color'], palette.accent],
          'fill-opacity': 0.1,
        },
      },
      TRACK_LINE,
    );
  }
  if (!map.getLayer(FENCE_LINE)) {
    map.addLayer(
      {
        id: FENCE_LINE,
        type: 'line',
        source: FENCE_SOURCE,
        paint: {
          'line-color': ['coalesce', ['get', 'color'], palette.accent],
          'line-width': ['case', ['==', ['get', 'selected'], true], 2.5, 1.5],
          'line-opacity': 0.55,
          'line-dasharray': ['case', ['==', ['get', 'dashed'], true], ['literal', [2, 2]], ['literal', [1, 0]]],
        },
      },
      TRACK_LINE,
    );
  }
}

function updateSources(map: MapLibreMap, fences: MapFence[], tracks: MapTrack[]) {
  const fenceSource = map.getSource(FENCE_SOURCE) as GeoJSONSource | undefined;
  const trackSource = map.getSource(TRACK_SOURCE) as GeoJSONSource | undefined;
  if (!fenceSource || !trackSource) return;

  fenceSource.setData({
    type: 'FeatureCollection',
    features: fences.map((fence) => ({
      type: 'Feature' as const,
      properties: {
        id: fence.id,
        color: fence.tone === 'amber' ? palette.amber : palette.accent,
        dashed: !!fence.dashed,
        selected: !!fence.selected,
        shape: hasPolygon(fence) ? 'polygon' : 'circle',
      },
      geometry: { type: 'Polygon' as const, coordinates: [fenceRing(fence)] },
    })),
  });

  trackSource.setData({
    type: 'FeatureCollection',
    features: tracks
      .filter((track) => track.points.length > 1)
      .map((track) => ({
        type: 'Feature' as const,
        properties: {
          id: track.id,
          color: track.tone === 'amber' ? palette.amber : palette.accentDark,
          dotted: !!track.dotted,
          width: track.width ?? 4,
        },
        geometry: {
          type: 'LineString' as const,
          coordinates: track.points.map((p) => [p.lon, p.lat] as [number, number]),
        },
      })),
  });
}

function emptyCollection(): GeoJSONSourceSpecification['data'] {
  return { type: 'FeatureCollection', features: [] };
}

/**
 * fallbackStyle is a valid MapLibre style with no remote sources, used when the
 * server has not configured tiles. It renders as a flat ground in the product's
 * palette, so fences and positions are still readable.
 */
function fallbackStyle(dark: boolean): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': dark ? color.inkPanel : color.mapBg },
      },
    ],
  };
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: color.mapBg },
  gl: { flex: 1 },
  overlays: absoluteFill,
});
