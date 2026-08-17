import { Component, useMemo, useRef, useState, type ReactNode } from 'react';
import { StyleSheet, View, type LayoutChangeEvent, type NativeSyntheticEvent } from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Camera, GeoJSONSource, Layer, Map, type MapRef, type ViewStateChangeEvent } from '@maplibre/maplibre-react-native';

import { color, palette } from '@/theme/tokens';

import { absoluteFill } from './fill';

import { FenceOverlay, MarkerOverlay } from './Overlays';
import { MapCanvas } from './MapCanvas';
import { circlePolygon, type Viewport } from './projection';
import type { MapViewProps } from './types';

/**
 * MapLibre Native on iOS and Android (HLD §13).
 *
 * MapLibre Native is a native module, so it needs a development build — HLD §17
 * flags that requirement as a risk to set up early. Rather than crash in Expo Go,
 * this file detects the runtime and falls back to the locally drawn canvas, so the
 * app is fully usable while a dev build is being set up and in airgap mode.
 *
 * The overlay design is shared with the web renderer: fences and tracks are map
 * layers, marker pills are React views positioned from the same projection.
 */

/** Expo Go cannot load a custom native module; the canvas fallback covers it. */
const IN_EXPO_GO = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

export function MapView(props: MapViewProps) {
  if (IN_EXPO_GO || props.offline) {
    return <MapCanvas {...props} />;
  }
  return (
    <NativeMapBoundary fallback={<MapCanvas {...props} />}>
      <NativeMap {...props} />
    </NativeMapBoundary>
  );
}

function NativeMap(props: MapViewProps) {
  const {
    center,
    zoom = 14,
    fences = [],
    markers = [],
    tracks = [],
    styleUrl,
    interactive = true,
    onPressMap,
    onPressFence,
    variant = 'light',
    recenterKey,
    onViewportChange,
  } = props;

  const dark = variant === 'dark';
  const mapRef = useRef<MapRef | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<Viewport>({ center, zoom, width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
    setView((prev) => ({ ...prev, width, height }));
  };

  const syncViewport = (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    const [lon, lat] = event.nativeEvent.center;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;
    const next = { center: { lat, lon }, zoom: event.nativeEvent.zoom };
    setView({ ...next, width: box.width, height: box.height });
    onViewportChange?.(next);
  };

  const fenceData = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: fences.map((fence) => ({
        type: 'Feature' as const,
        properties: {
          id: fence.id,
          color: fence.tone === 'amber' ? palette.amber : palette.accent,
          dashed: fence.dashed ? 1 : 0,
        },
        geometry: { type: 'Polygon' as const, coordinates: [circlePolygon(fence.center, fence.radiusM)] },
      })),
    }),
    [fences],
  );

  const trackData = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: tracks
        .filter((t) => t.points.length > 1)
        .map((track) => ({
          type: 'Feature' as const,
          properties: {
            color: track.tone === 'amber' ? palette.amber : palette.accentDark,
            width: track.width ?? 4,
          },
          geometry: {
            type: 'LineString' as const,
            coordinates: track.points.map((p) => [p.lon, p.lat] as [number, number]),
          },
        })),
    }),
    [tracks],
  );

  return (
    <View style={styles.container} onLayout={onLayout}>
      <Map
        ref={mapRef}
        style={styles.map}
        mapStyle={styleUrl ?? blankStyle(dark)}
        // Attribution is a licence requirement for OSM-derived tiles, so that
        // ornament stays; the logo and compass do not earn their pixels here.
        logo={false}
        attribution
        compass={false}
        // Gesture props are per-interaction in v11: pan and zoom follow the
        // `interactive` prop, while rotate and pitch stay off — a tilted, rotated
        // map makes a geofence circle unreadable.
        dragPan={interactive}
        touchZoom={interactive}
        doubleTapZoom={interactive}
        touchRotate={false}
        touchPitch={false}
        onPress={
          onPressMap
            ? (event) => {
                const [lon, lat] = event.nativeEvent.lngLat;
                if (typeof lat === 'number' && typeof lon === 'number') onPressMap({ lat, lon });
              }
            : undefined
        }
        // Region-is-changing fires continuously while the user pans, which is what
        // keeps the screen-space overlays pinned to the basemap; region-did-change
        // settles the final value.
        onRegionIsChanging={syncViewport}
        onRegionDidChange={syncViewport}
      >
        <Camera center={[center.lon, center.lat]} zoom={zoom} duration={400} key={recenterKey} />

        <GeoJSONSource id="lura-fences" data={fenceData}>
          <Layer id="lura-fence-fill" type="fill" paint={{ 'fill-color': ['get', 'color'], 'fill-opacity': 0.1 }} />
          <Layer
            id="lura-fence-line"
            type="line"
            paint={{ 'line-color': ['get', 'color'], 'line-width': 1.5, 'line-opacity': 0.55 }}
          />
        </GeoJSONSource>

        <GeoJSONSource id="lura-tracks" data={trackData}>
          <Layer
            id="lura-track-line"
            type="line"
            layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            paint={{ 'line-color': ['get', 'color'], 'line-width': ['get', 'width'] }}
          />
        </GeoJSONSource>
      </Map>

      <View style={styles.overlays} pointerEvents="box-none">
        <FenceOverlay fences={fences} view={view} dark={dark} onPress={onPressFence} />
        <MarkerOverlay markers={markers} view={view} dark={dark} />
      </View>
    </View>
  );
}

/** blankStyle keeps the map valid when no tile server is configured. */
function blankStyle(dark: boolean) {
  return {
    version: 8 as const,
    sources: {},
    layers: [
      {
        id: 'background',
        type: 'background' as const,
        paint: { 'background-color': dark ? color.inkPanel : color.mapBg },
      },
    ],
  };
}

/**
 * NativeMapBoundary catches a missing-native-module error and shows the canvas.
 *
 * A crash-on-render here would take the whole app down on a device that simply
 * has not been rebuilt yet, which is a bad trade for a basemap.
 */
class NativeMapBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[lura] native map unavailable, using the fallback canvas:', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden', backgroundColor: color.mapBg },
  map: { flex: 1 },
  overlays: absoluteFill,
});
