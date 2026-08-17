import type { Point } from '@/api/types';

/**
 * One map contract for three renderers.
 *
 * MapLibre GL JS (web), MapLibre Native (iOS/Android) and the fallback SVG canvas
 * all consume these props. Keeping the contract declarative — here are the
 * fences, here are the markers — is what lets the fallback be a real fallback
 * rather than a different feature set: airgap mode and Expo Go get the same map
 * semantics with a locally drawn basemap.
 */

export type MapTone = 'accent' | 'amber' | 'neutral';

/** MapFence is a geofence circle: metres, not pixels, so it scales with zoom. */
export type MapFence = {
  id: string;
  center: Point;
  radiusM: number;
  name?: string;
  /** Small label shown next to the name, e.g. "120m" or "pass-by". */
  badge?: string;
  tone?: MapTone;
  dashed?: boolean;
  selected?: boolean;
};

export type MapMarker = {
  id: string;
  point: Point;
  label?: string;
  tone?: MapTone;
  /** Live devices pulse; a shared contact's dot does not. */
  pulse?: boolean;
  /** Small hollow dot used for waypoints on a history track. */
  small?: boolean;
};

export type MapTrack = {
  id: string;
  points: Point[];
  tone?: MapTone;
  /** Dotted lines read as "a path we inferred", solid as "a path we recorded". */
  dotted?: boolean;
  width?: number;
};

export type MapViewProps = {
  center: Point;
  /** Web Mercator zoom level, matching MapLibre. */
  zoom?: number;
  fences?: MapFence[];
  markers?: MapMarker[];
  tracks?: MapTrack[];
  /** Style URL from the server (/api/v1/me → server.mapStyleUrl). */
  styleUrl?: string;
  /** Airgap mode must not fetch a remote basemap. */
  offline?: boolean;
  interactive?: boolean;
  /** Tapping the map while drawing a place returns the tapped coordinate. */
  onPressMap?: (point: Point) => void;
  onPressFence?: (id: string) => void;
  /** Dark styling for the share preview panel. */
  variant?: 'light' | 'dark';
  /** Recentres when this value changes (used by the "locate me" control). */
  recenterKey?: number;
  /**
   * Reports the live viewport back to the caller.
   *
   * The zoom controls need the centre and zoom: a button that adds one level has
   * to know what the user has already pinched to, or it fights them. The pixel
   * size is there so a caller can answer "is that marker actually on screen?" —
   * which is not a question the zoom level alone can answer.
   */
  onViewportChange?: (viewport: { center: Point; zoom: number; width: number; height: number }) => void;
};
