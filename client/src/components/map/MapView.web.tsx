// Metro bundles CSS imports for web, so MapLibre's stylesheet becomes part of the
// output bundle — a local asset, not a CDN request, which is what airgap mode
// requires. Without it the GL canvas is mis-sized and the controls are unstyled.
import 'maplibre-gl/dist/maplibre-gl.css';

import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Map as MapLibreMap,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type LngLatLike,
  type MapMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';

import { color, palette } from '@/theme/tokens';

import { absoluteFill } from './fill';
import { FenceOverlay, MarkerOverlay } from './Overlays';
import { MapCanvas } from './MapCanvas';
import { circlePolygon, type Viewport } from './projection';
import type { MapFence, MapTrack, MapViewProps } from './types';

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
 *   - No WebGL2, no GL map. MapLibre requires WebGL2 and reports its absence
 *     *asynchronously*, after the constructor returns — so it is probed up front
 *     and the failure path is also handled on the error event. Machines with a
 *     blocked or missing GPU (locked-down laptops, VMs, headless CI) then get the
 *     canvas renderer instead of a blank page.
 */

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

/** fatalMapError reports whether an error event means the map will never work. */
function fatalMapError(message: string): boolean {
  return (
    message.includes('WebGL') ||
    message.includes('GPUInitializationError') ||
    message.includes('style') ||
    message.includes('Failed to fetch')
  );
}

export function MapView(props: MapViewProps) {
  const {
    center,
    zoom = 14,
    fences = [],
    markers = [],
    tracks = [],
    styleUrl,
    offline,
    interactive = true,
    onPressMap,
    onPressFence,
    variant = 'light',
    recenterKey,
    onViewportChange,
  } = props;

  const dark = variant === 'dark';
  const hostRef = useRef<View | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const userMoved = useRef(false);
  // Held in a ref so changing the callback does not tear down the map.
  const viewportListener = useRef(onViewportChange);
  viewportListener.current = onViewportChange;
  const appliedZoom = useRef(zoom);
  // Probed once per mount: the answer cannot change while the page is open.
  const [failed, setFailed] = useState(() => !hasWebGL2());
  const [view, setView] = useState<Viewport>({ center, zoom, width: 0, height: 0 });

  // ---- create the map once
  useEffect(() => {
    if (offline || failed) return;
    const node = hostRef.current as unknown as HTMLDivElement | null;
    if (!node) return;

    let map: MapLibreMap;
    try {
      map = new MapLibreMap({
        container: node,
        style: styleUrl ?? fallbackStyle(dark),
        center: [center.lon, center.lat],
        zoom,
        attributionControl: false,
        interactive,
        // The map is a backdrop, not a game: a short fade keeps label swaps calm
        // without paying for extra frames.
        fadeDuration: 120,
      });
    } catch {
      setFailed(true);
      return;
    }
    mapRef.current = map;

    const syncView = () => {
      const c = map.getCenter();
      const canvas = map.getCanvas();
      const next = { center: { lat: c.lat, lon: c.lng }, zoom: map.getZoom() };
      setView({ ...next, width: canvas.clientWidth, height: canvas.clientHeight });
      viewportListener.current?.(next);
    };

    map.on('load', () => {
      installLayers(map, dark);
      syncView();
    });
    map.on('move', syncView);
    map.on('resize', syncView);
    map.on('dragstart', () => {
      userMoved.current = true;
    });
    map.on('zoomstart', () => {
      userMoved.current = true;
    });
    map.on('error', (event) => {
      // A missing tile is survivable; a missing GPU or an unloadable style is not.
      const err = (event as { error?: { message?: string; name?: string } }).error;
      const message = `${err?.name ?? ''} ${err?.message ?? ''}`;
      if (fatalMapError(message)) {
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
  }, [offline, failed, styleUrl, dark, interactive]);

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

  // ---- follow the centre until the user takes over
  useEffect(() => {
    withMap(mapRef.current, (map) => {
      if (userMoved.current) return;
      map.easeTo({ center: [center.lon, center.lat] as LngLatLike, duration: 400 });
    });
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
    withMap(mapRef.current, (map) => {
      const apply = () => withMap(map, (m) => updateSources(m, fences, tracks));
      if (map.isStyleLoaded()) apply();
      else map.once('load', apply);
    });
  }, [fences, tracks]);

  if (offline || failed) {
    return <MapCanvas {...props} />;
  }

  return (
    <View style={styles.container}>
      <View ref={hostRef} style={styles.gl} />
      {/* Overlays sit above the canvas and must not swallow map gestures. */}
      <View style={styles.overlays} pointerEvents="box-none">
        <FenceOverlay fences={fences} view={view} dark={dark} onPress={onPressFence} />
        <MarkerOverlay markers={markers} view={view} dark={dark} />
      </View>
    </View>
  );
}

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
      },
      geometry: { type: 'Polygon' as const, coordinates: [circlePolygon(fence.center, fence.radiusM)] },
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
