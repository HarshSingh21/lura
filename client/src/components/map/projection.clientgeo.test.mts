/**
 * projection.ts is what pins every overlay (marker pills, fence editor, trails)
 * to the basemap, so it must be MapLibre's Web Mercator with 512 px tiles, not
 * an approximation.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TILE_SIZE, circlePolygon, fitBounds, metresPerPixel, project, unproject, type Viewport } from './projection.ts';

const close = (actual: number, expected: number, eps: number, what = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what} expected ${expected} ± ${eps}, got ${actual}`);

const view: Viewport = { center: { lat: 12.97, lon: 77.59 }, zoom: 15, width: 390, height: 730 };

test('the centre of the view projects to the middle of the screen', () => {
  const p = project(view.center, view);
  close(p.x, 195, 1e-9);
  close(p.y, 365, 1e-9);
});

test('north is up and east is right', () => {
  const c = project(view.center, view);
  const north = project({ lat: view.center.lat + 0.001, lon: view.center.lon }, view);
  const east = project({ lat: view.center.lat, lon: view.center.lon + 0.001 }, view);
  assert.ok(north.y < c.y);
  close(north.x, c.x, 1e-9);
  assert.ok(east.x > c.x);
  close(east.y, c.y, 1e-9);
});

test('project and unproject are inverses, anywhere on screen and off it', () => {
  for (const [x, y] of [
    [0, 0],
    [390, 730],
    [12.5, 600.25],
    [-400, 1500],
  ] as const) {
    const g = unproject(x, y, view);
    const back = project(g, view);
    close(back.x, x, 1e-6, 'x');
    close(back.y, y, 1e-6, 'y');
  }
  for (const p of [
    { lat: 12.9716, lon: 77.5946 },
    { lat: 28.6139, lon: 77.209 },
    { lat: -33.86, lon: 151.21 },
  ]) {
    const v = { ...view, center: p };
    const s = project({ lat: p.lat + 0.003, lon: p.lon - 0.004 }, v);
    const g = unproject(s.x, s.y, v);
    close(g.lat, p.lat + 0.003, 1e-9);
    close(g.lon, p.lon - 0.004, 1e-9);
  }
});

test('one zoom level doubles every on-screen distance', () => {
  const a = { lat: 12.97, lon: 77.6 };
  const d15 = project(a, view).x - project(view.center, view).x;
  const v16 = { ...view, zoom: 16 };
  const d16 = project(a, v16).x - project(view.center, v16).x;
  close(d16, 2 * d15, 1e-6);
});

test('metresPerPixel is MapLibre\'s, for 512 px tiles', () => {
  assert.equal(TILE_SIZE, 512);
  // At the equator and zoom 0 one 512 px tile spans the earth's circumference.
  close(metresPerPixel(0, 0), 40_075_016.686 / 512, 0.01);
  // Halves with every zoom level, and shrinks with cos(latitude).
  close(metresPerPixel(0, 1), metresPerPixel(0, 0) / 2, 1e-9);
  close(metresPerPixel(60, 10), metresPerPixel(0, 10) / 2, 1e-6);
});

test('metresPerPixel agrees with the projection: 100 m east is 100/mpp pixels', () => {
  const lat = view.center.lat;
  const dLon = 100 / (111_320 * Math.cos((lat * Math.PI) / 180));
  const px = project({ lat, lon: view.center.lon + dLon }, view).x - project(view.center, view).x;
  close(px, 100 / metresPerPixel(lat, view.zoom), 0.05);
});

test('fitBounds shows every point inside the padding, at the closest zoom that does', () => {
  const points = [
    { lat: 12.95, lon: 77.57 },
    { lat: 12.99, lon: 77.63 },
    { lat: 12.97, lon: 77.6 },
  ];
  const fit = fitBounds(points, 390, 730, 48);
  assert.ok(fit);
  if (!fit) return;
  const v = { center: fit.center, zoom: fit.zoom, width: 390, height: 730 };
  for (const p of points) {
    const s = project(p, v);
    assert.ok(s.x >= 48 - 1e-6 && s.x <= 390 - 48 + 1e-6, `x ${s.x}`);
    assert.ok(s.y >= 48 - 1e-6 && s.y <= 730 - 48 + 1e-6, `y ${s.y}`);
  }
  // A quarter-step closer no longer fits.
  const tighter = { ...v, zoom: fit.zoom + 0.25 };
  const outside = points.some((p) => {
    const s = project(p, tighter);
    return s.x < 48 || s.x > 390 - 48 || s.y < 48 || s.y > 730 - 48;
  });
  assert.ok(outside);
});

test('fitBounds: one point opens at the maximum zoom, nothing usable is null', () => {
  assert.deepEqual(fitBounds([{ lat: 12.97, lon: 77.59 }], 390, 730), { center: { lat: 12.97, lon: 77.59 }, zoom: 16 });
  assert.equal(fitBounds([], 390, 730), null);
  assert.equal(fitBounds([{ lat: Number.NaN, lon: 77 }], 390, 730), null);
});

test('circlePolygon is a closed ring at the radius', () => {
  const ring = circlePolygon({ lat: 12.97, lon: 77.59 }, 200, 32);
  assert.equal(ring.length, 33);
  assert.deepEqual(ring[0], ring[32]);
  const rad = Math.PI / 180;
  for (const [lon, lat] of ring) {
    const dy = (lat - 12.97) * 111_320;
    const dx = (lon - 77.59) * 111_320 * Math.cos(12.97 * rad);
    close(Math.hypot(dx, dy), 200, 0.5);
  }
});
