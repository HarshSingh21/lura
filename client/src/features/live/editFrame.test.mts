import assert from 'node:assert/strict';
import { test } from 'node:test';

import { editPadding, fenceExtent } from './editFrame.ts';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test('a circle is kept on screen by its rim, north, south, east and west', () => {
  const c = { lat: 12.9768, lon: 77.6352 };
  const pts = fenceExtent({ center: c, radiusM: 316 });
  assert.equal(pts.length, 4);
  const metres = (p: { lat: number; lon: number }) =>
    Math.hypot((p.lat - c.lat) * 111_320, (p.lon - c.lon) * 111_320 * Math.cos((c.lat * Math.PI) / 180));
  for (const p of pts) assert.ok(near(metres(p), 316, 1e-6), `rim point ${JSON.stringify(p)} is ${metres(p)} m out`);
});

test('a polygon is kept on screen by its corners', () => {
  const ring = [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }, { lat: 2, lon: 2 }];
  assert.deepEqual(fenceExtent({ center: { lat: 1.5, lon: 1.5 }, radiusM: 80000, polygon: ring }), ring);
});

test('a degenerate ring falls back to the circle', () => {
  assert.equal(fenceExtent({ center: { lat: 0, lon: 0 }, radiusM: 50, polygon: [{ lat: 0, lon: 0 }] }).length, 4);
});

test('on a phone the margin clears the 62 px control column and half a 44 px handle', () => {
  assert.ok(editPadding(true) >= 18 + 44 + 22);
  assert.ok(editPadding(false) < editPadding(true));
});
