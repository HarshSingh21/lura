import { useState, type ComponentType, type ReactNode } from 'react';
import { StyleSheet, TurboModuleRegistry, View, type LayoutChangeEvent } from 'react-native';

import { color } from '@/theme/tokens';

import { absoluteFill } from './fill';
import { FenceOverlay, MarkerOverlay, TrackOverlay } from './Overlays';
import { FenceEditor } from './FenceEditor';
import type { Viewport } from './projection';
import type { MapViewProps } from './types';

/**
 * Mappls Maps on iOS and Android, when the server opts into Mappls.
 *
 * Mappls' native SDK is only compiled into builds made with `LURA_MAPPLS=1`
 * (see react-native.config.js and plugins/with-mappls.js), because its Android
 * build refuses to run without the licence files. Every other build — the
 * default, open one — leaves it out, so this module is required lazily and only
 * once the native side is known to be present. Importing it eagerly would throw
 * at startup on exactly the builds that never asked for it.
 *
 * As on the web, Mappls draws the basemap and Lura's shared overlays draw
 * everything on it.
 */

type Feature = { geometry?: { coordinates?: unknown }; properties?: { zoomLevel?: number } };

/** The slice of mappls-map-react-native this renderer relies on. */
type MapplsModule = {
  MapView: ComponentType<{
    style?: object;
    children?: ReactNode;
    compassEnabled?: boolean;
    rotateEnabled?: boolean;
    pitchEnabled?: boolean;
    scrollEnabled?: boolean;
    zoomEnabled?: boolean;
    attributionEnabled?: boolean;
    onPress?: (feature: Feature) => void;
    onRegionIsChanging?: (feature: Feature) => void;
    onRegionDidChange?: (feature: Feature) => void;
    onMapError?: (error: { code: number; message?: string }) => void;
  }>;
  Camera: ComponentType<{
    centerCoordinate?: [number, number];
    zoomLevel?: number;
    animationDuration?: number;
    animationMode?: 'flyTo' | 'easeTo' | 'linearTo' | 'moveTo';
  }>;
};

let cached: MapplsModule | null | undefined;

/** loadMappls returns the SDK, or null when this build was made without it. */
export function loadMappls(): MapplsModule | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    // A non-throwing probe: null when the native module is not in this binary.
    if (TurboModuleRegistry.get('RCTMGLModule')) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      cached = require('mappls-map-react-native') as MapplsModule;
    }
  } catch (error) {
    console.warn('[lura] Mappls SDK unavailable, using MapLibre:', error);
  }
  return cached;
}

/** lonLat reads a GeoJSON Point position out of an SDK event, or null. */
function lonLat(feature: Feature): { lat: number; lon: number } | null {
  const coords = feature.geometry?.coordinates;
  if (!Array.isArray(coords)) return null;
  const [lon, lat] = coords as unknown[];
  return typeof lat === 'number' && typeof lon === 'number' ? { lat, lon } : null;
}

export function MapplsNativeMap(props: MapViewProps & { sdk: MapplsModule; onFail: () => void }) {
  const {
    sdk,
    onFail,
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
  const { MapView, Camera } = sdk;

  const dark = variant === 'dark';
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<Viewport>({ center, zoom, width: 0, height: 0 });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setBox({ width, height });
    setView((prev) => ({ ...prev, width, height }));
  };

  const syncViewport = (feature: Feature) => {
    const point = lonLat(feature);
    const z = feature.properties?.zoomLevel;
    if (!point || typeof z !== 'number') return;
    const next = { center: point, zoom: z, width: box.width, height: box.height };
    setView(next);
    onViewportChange?.(next);
  };

  return (
    <View style={styles.container} onLayout={onLayout}>
      <MapView
        style={styles.map}
        // The Mappls logo and attribution are a licence requirement and stay;
        // rotation and tilt are off, as on MapLibre, so a fence stays a circle.
        attributionEnabled
        compassEnabled={false}
        rotateEnabled={false}
        pitchEnabled={false}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        onPress={
          onPressMap
            ? (feature) => {
                const point = lonLat(feature);
                if (point) onPressMap(point);
              }
            : undefined
        }
        onRegionIsChanging={syncViewport}
        onRegionDidChange={syncViewport}
        onMapError={(error) => {
          console.warn('[lura] Mappls map error, using MapLibre:', error.code, error.message);
          onFail();
        }}
      >
        <Camera
          key={recenterKey}
          centerCoordinate={[center.lon, center.lat]}
          zoomLevel={zoom}
          animationDuration={400}
          animationMode="easeTo"
        />
      </MapView>

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
