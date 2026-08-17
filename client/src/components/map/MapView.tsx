import { MapCanvas } from './MapCanvas';
import type { MapViewProps } from './types';

/**
 * Platform-neutral entry point for the map.
 *
 * Metro resolves `./MapView` to MapView.web.tsx on web and MapView.native.tsx on
 * iOS/Android, so this file is only reached where neither exists (a plain Node
 * test runner, for example). It renders the locally drawn canvas, which needs no
 * GL context — and it also gives TypeScript a module to resolve, since a bare
 * platform-suffixed pair is invisible to the compiler.
 */
export function MapView(props: MapViewProps) {
  return <MapCanvas {...props} />;
}

export type { MapViewProps };
