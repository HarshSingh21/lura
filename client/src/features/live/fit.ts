import type { Point } from '@/api/types';

/**
 * Choosing a zoom that actually shows everyone.
 *
 * A live map that is centred on you and fixed at zoom 14 will happily place the
 * person you are watching two screens away — the marker exists, the socket works,
 * and the product still fails, because "where are they" was the question. This
 * answers it in the only place it can be answered: pixels.
 *
 * The maths is plain Web Mercator, the same projection MapLibre uses, so the
 * result agrees with what the GL map will actually draw.
 */

/** TILE_SIZE is MapLibre's, and fixes what one zoom level means in pixels. */
const TILE_SIZE = 512;

/** Sane bounds: below 2 the world repeats, above 18 there is nothing left to see. */
const MIN_ZOOM = 2;
const MAX_ZOOM = 18;

/** worldX maps longitude to [0,1). */
function worldX(lon: number): number {
  return (lon + 180) / 360;
}

/** worldY maps latitude to [0,1), clamped away from the poles where it diverges. */
function worldY(lat: number): number {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const rad = (clamped * Math.PI) / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
}

export type Box = { width: number; height: number };

/**
 * zoomToInclude returns the closest zoom at which every point is still on screen
 * around `center`, or `undefined` when there is nothing to fit or no viewport to
 * fit it into.
 *
 * `padding` is in CSS pixels and is generous on purpose: a marker whose pill
 * touches the edge of the map reads as cut off, and the rail and the map controls
 * cover the corners.
 */
export function zoomToInclude(
  center: Point,
  points: Point[],
  box: Box,
  padding = 96,
): number | undefined {
  if (points.length === 0) return undefined;
  if (box.width <= 0 || box.height <= 0) return undefined;

  const halfWidth = box.width / 2 - padding;
  const halfHeight = box.height / 2 - padding;
  // A viewport smaller than its own padding cannot fit anything; leave the zoom
  // alone rather than returning a nonsense number.
  if (halfWidth <= 8 || halfHeight <= 8) return undefined;

  const cx = worldX(center.lon);
  const cy = worldY(center.lat);

  let zoom = MAX_ZOOM;
  for (const point of points) {
    const dx = Math.abs(worldX(point.lon) - cx);
    const dy = Math.abs(worldY(point.lat) - cy);
    // Two fixes a metre apart must not force a zoom of 40.
    if (dx > 1e-9) zoom = Math.min(zoom, Math.log2(halfWidth / (TILE_SIZE * dx)));
    if (dy > 1e-9) zoom = Math.min(zoom, Math.log2(halfHeight / (TILE_SIZE * dy)));
  }

  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}
