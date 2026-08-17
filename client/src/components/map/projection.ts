import type { Point } from '@/api/types';

/**
 * Web Mercator helpers.
 *
 * The overlays (marker pills, fence labels) are React Native views positioned in
 * screen space, not map layers — that is how the mock's marker design survives on
 * all three platforms. To place them, the client needs the same projection
 * MapLibre uses, so these are the standard Web Mercator formulas rather than an
 * approximation: anything else would drift from the basemap as you pan.
 */

export const TILE_SIZE = 512;

/** metresPerPixel at a latitude and zoom, for sizing a fence in screen space. */
export function metresPerPixel(lat: number, zoom: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / (TILE_SIZE / 256);
}

export type Viewport = { center: Point; zoom: number; width: number; height: number };

/** project converts a coordinate to a pixel offset within the viewport. */
export function project(point: Point, view: Viewport): { x: number; y: number } {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const world = lonLatToWorld(point, scale);
  const centerWorld = lonLatToWorld(view.center, scale);
  return {
    x: view.width / 2 + (world.x - centerWorld.x),
    y: view.height / 2 + (world.y - centerWorld.y),
  };
}

/** unproject converts a pixel offset back to a coordinate (used for map taps). */
export function unproject(x: number, y: number, view: Viewport): Point {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const centerWorld = lonLatToWorld(view.center, scale);
  const worldX = centerWorld.x + (x - view.width / 2);
  const worldY = centerWorld.y + (y - view.height / 2);
  return worldToLonLat(worldX, worldY, scale);
}

function lonLatToWorld(point: Point, scale: number): { x: number; y: number } {
  const lat = clamp(point.lat, -85.05112878, 85.05112878);
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: scale * (0.5 + point.lon / 360),
    y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)),
  };
}

function worldToLonLat(x: number, y: number, scale: number): Point {
  const lon = (x / scale - 0.5) * 360;
  const n = Math.PI * (1 - 2 * (y / scale));
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return { lat, lon };
}

/**
 * fitBounds returns the centre and zoom that show every point with padding.
 * Used by the history view, which should open on the day rather than on a
 * hard-coded city.
 */
export function fitBounds(
  points: Point[],
  width: number,
  height: number,
  padding = 48,
  maxZoom = 16,
): { center: Point; zoom: number } | null {
  const usable = points.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  if (usable.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const p of usable) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
  }

  const center: Point = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);

  // Solve for the largest zoom at which the bounds still fit both axes.
  let zoom = maxZoom;
  for (let z = maxZoom; z >= 1; z -= 0.25) {
    const scale = TILE_SIZE * 2 ** z;
    const nw = lonLatToWorld({ lat: maxLat, lon: minLon }, scale);
    const se = lonLatToWorld({ lat: minLat, lon: maxLon }, scale);
    if (Math.abs(se.x - nw.x) <= usableWidth && Math.abs(se.y - nw.y) <= usableHeight) {
      zoom = z;
      break;
    }
    zoom = z;
  }
  return { center, zoom };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

/** circlePolygon approximates a geofence circle as a ring of coordinates. */
export function circlePolygon(center: Point, radiusM: number, steps = 64): [number, number][] {
  const coords: [number, number][] = [];
  const latRad = (center.lat * Math.PI) / 180;
  const dLat = (radiusM / 111_320) ;
  const dLon = radiusM / (111_320 * Math.max(Math.cos(latRad), 1e-6));
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * 2 * Math.PI;
    coords.push([center.lon + dLon * Math.cos(angle), center.lat + dLat * Math.sin(angle)]);
  }
  return coords;
}
