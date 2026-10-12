import type { MapProvider, Point } from '@/api/types';

/**
 * One map contract for every renderer.
 *
 * MapLibre GL JS (web), MapLibre Native (iOS/Android), Mappls (web and native,
 * when the server opts into it) and the fallback SVG canvas all consume these
 * props. Keeping the contract declarative — here are the
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
  /** When set (3+ vertices) the fence is drawn as this polygon instead of the circle. */
  polygon?: Point[];
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
  /** Degrees clockwise from north; draws a heading cone when set. */
  headingDeg?: number;
  /** GPS accuracy radius in metres; drawn as a translucent circle when set. */
  accuracyM?: number;
  /** Per-person colour (hex). Overrides tone. */
  color?: string;
  /** Glide from the previous point to this one over ~this many ms (live pings). 0 = jump. */
  animateMs?: number;
  /** Changing this value plays a one-shot "arrived" ripple on the marker. */
  rippleKey?: string | number;
  /**
   * Recent positions, oldest first, drawn as a fading wake behind the marker in
   * its colour. The newest entry is normally `point` itself.
   */
  trail?: Point[];
};

/** Basemaps the user can choose between. Each renderer maps these to its own styles. */
export type BasemapId = 'streets' | 'satellite' | 'hybrid' | 'light' | 'dark' | 'terrain';

/**
 * FenceEditState drives the renderer-agnostic geofence editor overlay
 * (client/src/components/map/FenceEditor.tsx). The editor reports geometry
 * changes; the caller decides when to persist (PATCH /api/v1/places/{id}).
 */
export type FenceEditState =
  | { mode: 'draw-circle' }
  | { mode: 'draw-polygon'; vertices: Point[] }
  | { mode: 'draw-freehand' }
  | { mode: 'edit'; fenceId: string; shape: 'circle'; center: Point; radiusM: number }
  | { mode: 'edit'; fenceId: string; shape: 'polygon'; polygon: Point[] };

export type FenceGeometry =
  | { shape: 'circle'; center: Point; radiusM: number }
  | { shape: 'polygon'; polygon: Point[] };

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
  /**
   * Which basemap the server asked for (server.mapProvider). Mappls needs its
   * web key on the web and its bundled credentials on a phone; without them the
   * map quietly falls back to MapLibre rather than showing nothing.
   */
  provider?: MapProvider;
  /** Mappls Web SDK browser key (server.mapplsWebKey). */
  mapplsKey?: string;
  /**
   * Reports which renderer is drawing the basemap. It is not always `provider`:
   * Mappls hands over to MapLibre when it fails, or for a basemap it has no
   * style for, and the attribution has to follow.
   */
  onRenderer?: (renderer: MapProvider) => void;
  /** Airgap mode must not fetch a remote basemap. */
  offline?: boolean;
  interactive?: boolean;
  /** Tapping the map while drawing a place returns the tapped coordinate. */
  onPressMap?: (point: Point) => void;
  onPressFence?: (id: string) => void;
  /** Selected basemap; renderers fall back to 'streets' for anything they cannot draw. */
  basemap?: BasemapId;
  /** When set, the FenceEditor overlay is active and map panning yields to it where needed. */
  fenceEdit?: FenceEditState;
  /** Live geometry while drawing/moving/resizing. `done` is true on gesture end / polygon close. */
  onFenceGeometry?: (geometry: FenceGeometry, done: boolean) => void;
  /** Dark styling for the share preview panel. */
  variant?: 'light' | 'dark';
  /** Recentres when this value changes (used by the "locate me" control). */
  recenterKey?: number;
  /**
   * Follow mode: when set, every change of `center` moves the camera there over
   * this many milliseconds with linear easing — even after the user has panned —
   * so the camera keeps pace with a marker gliding at the same rate.
   */
  followMs?: number;
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
