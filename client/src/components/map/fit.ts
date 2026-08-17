import type { Point } from '@/api/types';

/**
 * Choosing a zoom that actually shows everyone.
 *
 * Lives beside `projection.ts` rather than in a feature folder: the live map and
 * the public share viewer both need it, and neither owns it.
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
 * Insets describe what is *covering* the map, per side, in CSS pixels.
 *
 * They are per-side rather than a single number because the things that cover a
 * map are not symmetrical: a summary panel spans the bottom of a phone screen and
 * sits in the top-left corner of a desktop one. A marker hidden behind that panel
 * is exactly as useless as one off the edge, and a uniform padding big enough to
 * clear it would throw away the other three sides.
 */
export type Insets = { top?: number; right?: number; bottom?: number; left?: number };

function insetsOf(padding: number | Insets): Required<Insets> {
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return {
    top: padding.top ?? 0,
    right: padding.right ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
  };
}

/**
 * zoomToInclude returns the closest zoom at which every point is still visible
 * around `center`, or `undefined` when there is nothing to fit or no viewport to
 * fit it into.
 */
export function zoomToInclude(
  center: Point,
  points: Point[],
  box: Box,
  padding: number | Insets = 96,
): number | undefined {
  if (points.length === 0) return undefined;
  if (box.width <= 0 || box.height <= 0) return undefined;

  const inset = insetsOf(padding);
  const room = {
    left: box.width / 2 - inset.left,
    right: box.width / 2 - inset.right,
    top: box.height / 2 - inset.top,
    bottom: box.height / 2 - inset.bottom,
  };
  // A viewport smaller than the things covering it cannot fit anything; leave the
  // zoom alone rather than returning a nonsense number.
  if (Math.min(room.left, room.right, room.top, room.bottom) <= 8) return undefined;

  const cx = worldX(center.lon);
  const cy = worldY(center.lat);

  let zoom = MAX_ZOOM;
  for (const point of points) {
    // Signed, so each point is measured against the room on *its* side.
    const dx = worldX(point.lon) - cx;
    const dy = worldY(point.lat) - cy;
    // World Y grows southwards, so a positive dy means the point is below centre.
    const horizontal = dx < 0 ? room.left : room.right;
    const vertical = dy < 0 ? room.top : room.bottom;
    // Two fixes a metre apart must not force a zoom of 40.
    if (Math.abs(dx) > 1e-9) zoom = Math.min(zoom, Math.log2(horizontal / (TILE_SIZE * Math.abs(dx))));
    if (Math.abs(dy) > 1e-9) zoom = Math.min(zoom, Math.log2(vertical / (TILE_SIZE * Math.abs(dy))));
  }

  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}
