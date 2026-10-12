// Web Mercator, exactly as client/src/components/map/projection.ts does it, so
// the suite turns a coordinate into the same pixel the overlays are drawn at.

export const TILE_SIZE = 512;

function world(p, scale) {
  const lat = Math.min(85.05112878, Math.max(-85.05112878, p.lat));
  const sin = Math.sin((lat * Math.PI) / 180);
  return { x: scale * (0.5 + p.lon / 360), y: scale * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) };
}

/** project maps a point into viewport pixels (relative to the map's top-left). */
export function project(p, view) {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const w = world(p, scale);
  const c = world(view.center, scale);
  return { x: view.width / 2 + (w.x - c.x), y: view.height / 2 + (w.y - c.y) };
}

/** unproject maps viewport pixels back to a point. */
export function unproject(x, y, view) {
  const scale = TILE_SIZE * 2 ** view.zoom;
  const c = world(view.center, scale);
  const wx = c.x + (x - view.width / 2);
  const wy = c.y + (y - view.height / 2);
  const lon = (wx / scale - 0.5) * 360;
  const n = Math.PI * (1 - 2 * (wy / scale));
  return { lat: (180 / Math.PI) * Math.atan(Math.sinh(n)), lon };
}

export function metresPerPixel(lat, zoom) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom / (TILE_SIZE / 256);
}

export function haversineM(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** pointInPolygon is ray casting on lat/lon, the memory store's rule. */
export function pointInPolygon(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.lat > p.lat !== b.lat > p.lat && p.lon < ((b.lon - a.lon) * (p.lat - a.lat)) / (b.lat - a.lat) + a.lon) {
      inside = !inside;
    }
  }
  return inside;
}

/** lerp walks a fraction of the way from a to b. */
export function lerp(a, b, t) {
  return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}
