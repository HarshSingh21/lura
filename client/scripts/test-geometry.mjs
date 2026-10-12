#!/usr/bin/env node
/**
 * Unit tests for src/components/map/geometry.ts.
 *
 * The client has no test runner, and adding Jest for one pure module would be a
 * lot of machinery. geometry.ts has no imports by design, so it can be compiled
 * on its own with the TypeScript compiler the project already depends on and
 * loaded straight from memory — the assertions below run against the real
 * source, not a hand-maintained JavaScript copy of it.
 *
 *   npm run test:geometry
 */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(here, '..', 'src', 'components', 'map', 'geometry.ts');
const { outputText } = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: sourcePath,
});
const g = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

// A ~200 m square near central Bengaluru, counter-clockwise.
const square = [
  { lat: 12.97, lon: 77.59 },
  { lat: 12.97, lon: 77.592 },
  { lat: 12.972, lon: 77.592 },
  { lat: 12.972, lon: 77.59 },
];

const close = (actual, expected, eps, message) =>
  assert.ok(Math.abs(actual - expected) <= eps, `${message ?? ''} expected ${expected} ± ${eps}, got ${actual}`);

test('haversine matches a known distance', () => {
  // One degree of latitude is ~111.2 km everywhere.
  close(g.haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111_195, 50);
  assert.equal(g.haversineM(square[0], square[0]), 0);
});

test('clampRadius keeps the server limits and rounds', () => {
  assert.equal(g.clampRadius(3), 25);
  assert.equal(g.clampRadius(9000), 5000);
  assert.equal(g.clampRadius(120.4), 120);
  assert.equal(g.clampRadius(Number.NaN), 25);
});

test('centroid of a square is its centre, in either winding', () => {
  const c = g.polygonCentroid(square);
  close(c.lat, 12.971, 1e-9);
  close(c.lon, 77.591, 1e-9);
  const cw = g.polygonCentroid([...square].reverse());
  close(cw.lat, 12.971, 1e-9);
  close(cw.lon, 77.591, 1e-9);
});

test('centroid is area-weighted, not a vertex average', () => {
  // Extra collinear points crowd one edge; an average would drift towards them.
  const crowded = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.25 },
    { lat: 0, lon: 0.5 },
    { lat: 0, lon: 0.75 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];
  const c = g.polygonCentroid(crowded);
  close(c.lat, 0.5, 1e-9);
  close(c.lon, 0.5, 1e-9);
});

test('centroid of a degenerate ring falls back to the average', () => {
  const line = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 0, lon: 2 },
  ];
  const c = g.polygonCentroid(line);
  close(c.lon, 1, 1e-12);
  close(c.lat, 0, 1e-12);
});

test('boundingRadius is the farthest vertex, rounded up', () => {
  const r = g.boundingRadiusM(square);
  // Half the diagonal of a ~217 m × ~222 m box.
  assert.ok(r > 150 && r < 160, `got ${r}`);
  assert.equal(r, Math.ceil(r));
});

test('self-intersection: a simple polygon passes', () => {
  assert.equal(g.polygonSelfIntersects(square), false);
  assert.equal(g.polygonSelfIntersects(square.slice(0, 3)), false);
});

test('self-intersection: a bow-tie is rejected', () => {
  const bowtie = [square[0], square[2], square[1], square[3]];
  assert.equal(g.polygonSelfIntersects(bowtie), true);
});

test('self-intersection: a concave polygon passes', () => {
  const arrow = [
    { x: 0, y: 0 },
    { x: 10, y: 5 },
    { x: 0, y: 10 },
    { x: 4, y: 5 },
  ];
  assert.equal(g.ringSelfIntersectsXY(arrow), false);
});

test('self-intersection: a spike that doubles back is rejected', () => {
  const spike = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 10 },
  ];
  assert.equal(g.ringSelfIntersectsXY(spike), true);
});

test('self-intersection: a repeated vertex is rejected', () => {
  const dup = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 0 },
    { x: 0, y: 10 },
  ];
  assert.equal(g.ringSelfIntersectsXY(dup), true);
});

test('self-intersection: a vertex touching another edge is rejected', () => {
  const touch = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 5, y: 0 }, // lies on the first edge
    { x: 0, y: 10 },
  ];
  assert.equal(g.ringSelfIntersectsXY(touch), true);
});

test('open path intersection catches a crossing before the ring closes', () => {
  const z = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 0 },
    { lat: 1, lon: 1 },
  ];
  assert.equal(g.pathSelfIntersects(z.slice(0, 3)), false);
  assert.equal(g.pathSelfIntersects([...z, { lat: -1, lon: 0.5 }]), true);
});

test('segmentsIntersect handles crossing, touching and disjoint segments', () => {
  const p = (x, y) => ({ x, y });
  assert.equal(g.segmentsIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0)), true);
  assert.equal(g.segmentsIntersect(p(0, 0), p(10, 0), p(10, 0), p(10, 10)), true);
  assert.equal(g.segmentsIntersect(p(0, 0), p(10, 0), p(0, 1), p(10, 1)), false);
  assert.equal(g.segmentsIntersect(p(0, 0), p(4, 0), p(5, 0), p(9, 0)), false);
  assert.equal(g.segmentsIntersect(p(0, 0), p(6, 0), p(5, 0), p(9, 0)), true);
});

test('pointInPolygon on a square and a concave shape', () => {
  assert.equal(g.pointInPolygon({ lat: 12.971, lon: 77.591 }, square), true);
  assert.equal(g.pointInPolygon({ lat: 12.975, lon: 77.591 }, square), false);
  const u = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 3 },
    { lat: 3, lon: 3 },
    { lat: 3, lon: 2 },
    { lat: 1, lon: 2 },
    { lat: 1, lon: 1 },
    { lat: 3, lon: 1 },
    { lat: 3, lon: 0 },
  ];
  assert.equal(g.pointInPolygon({ lat: 2, lon: 1.5 }, u), false, 'inside the notch is outside');
  assert.equal(g.pointInPolygon({ lat: 2, lon: 0.5 }, u), true);
  assert.equal(g.pointInPolygon({ lat: 0.5, lon: 1.5 }, u), true);
});

test('translate, insert and remove vertices', () => {
  const moved = g.translatePolygon(square, 0.01, -0.02);
  close(moved[0].lat, 12.98, 1e-12);
  close(moved[0].lon, 77.57, 1e-12);
  assert.equal(square[0].lat, 12.97, 'input is not mutated');

  const inserted = g.insertVertex(square, 0, { lat: 1, lon: 1 });
  assert.equal(inserted.length, 5);
  assert.deepEqual(inserted[1], { lat: 1, lon: 1 });
  assert.equal(square.length, 4);

  assert.equal(g.removeVertex(square, 1).length, 3);
  const triangle = square.slice(0, 3);
  assert.equal(g.removeVertex(triangle, 0), triangle, 'a triangle keeps its corners');

  const m = g.midpoint(square[0], square[1]);
  close(m.lon, 77.591, 1e-12);
});

test('validatePolygon explains what is wrong', () => {
  assert.equal(g.validatePolygon(square), null);
  assert.match(g.validatePolygon(square.slice(0, 2)), /three/);
  assert.match(g.validatePolygon([square[0], square[2], square[1], square[3]]), /cross/);
  const tiny = [
    { lat: 12.97, lon: 77.59 },
    { lat: 12.97, lon: 77.59001 },
    { lat: 12.97001, lon: 77.59 },
  ];
  assert.match(g.validatePolygon(tiny), /small/);
  const huge = [
    { lat: 12, lon: 77 },
    { lat: 12, lon: 78 },
    { lat: 13, lon: 77 },
  ];
  assert.match(g.validatePolygon(huge), /large/);
});

test('simplifyPath keeps the corners of a noisy line', () => {
  const pts = [];
  for (let i = 0; i <= 100; i += 1) pts.push({ x: i, y: i % 2 === 0 ? 0 : 0.3 });
  pts.push({ x: 100, y: 50 });
  const out = g.simplifyPath(pts, 1);
  assert.deepEqual(out[0], { x: 0, y: 0 });
  assert.deepEqual(out[out.length - 1], { x: 100, y: 50 });
  assert.ok(out.length <= 4, `got ${out.length}`);
});

test('simplifyRing reduces a dense circle to the budget and keeps it simple', () => {
  const sketch = [];
  for (let i = 0; i < 720; i += 1) {
    const a = (i / 720) * 2 * Math.PI;
    // A wobbly hand-drawn circle.
    const r = 120 + Math.sin(i * 0.7) * 1.5;
    sketch.push({ x: 200 + r * Math.cos(a), y: 200 + r * Math.sin(a) });
  }
  sketch.push({ ...sketch[0] });
  const out = g.simplifyRing(sketch, 60);
  assert.ok(out.length >= 3 && out.length <= 60, `got ${out.length}`);
  assert.equal(g.ringSelfIntersectsXY(out), false);
  // The outline still spans the circle.
  const xs = out.map((p) => p.x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 220);
});

test('simplifyRing honours a tight budget and drops the closing duplicate', () => {
  const square = [
    { x: 0, y: 0 },
    { x: 50, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 },
    { x: 0, y: 0 },
  ];
  const out = g.simplifyRing(square, 60);
  assert.equal(out.length, 4);
  const few = g.simplifyRing(
    Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * 2 * Math.PI;
      return { x: 100 * Math.cos(a), y: 100 * Math.sin(a) };
    }),
    8,
  );
  assert.ok(few.length >= 3 && few.length <= 8, `got ${few.length}`);
});

test('simplifyRing of a dot is not a shape', () => {
  const out = g.simplifyRing([{ x: 5, y: 5 }, { x: 5.2, y: 5.1 }, { x: 5, y: 5 }]);
  assert.ok(out.length < 3);
});

test('scanlineSpans fills a square exactly and a U-shape with two strips per row', () => {
  const sq = [
    { x: 10, y: 10 },
    { x: 50, y: 10 },
    { x: 50, y: 50 },
    { x: 10, y: 50 },
  ];
  const spans = g.scanlineSpans(sq, 10, 1000);
  assert.equal(spans.length, 4);
  for (const s of spans) {
    close(s.x0, 10, 1e-9);
    close(s.x1, 50, 1e-9);
  }
  close(spans[0].y, 10, 1e-9);
  close(spans.reduce((sum, s) => sum + s.height, 0), 40, 1e-9);

  const u = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 30 },
    { x: 20, y: 30 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
    { x: 30, y: 40 },
    { x: 0, y: 40 },
  ];
  const uSpans = g.scanlineSpans(u, 10, 1000);
  const firstRow = uSpans.filter((s) => s.y === 0);
  assert.equal(firstRow.length, 2, 'the notch splits the top rows');
  const lastRow = uSpans.filter((s) => s.y === 30);
  assert.equal(lastRow.length, 1);
});

test('scanlineSpans clips to the viewport', () => {
  const big = g.circleRingXY({ x: 100, y: 100 }, 10_000);
  const spans = g.scanlineSpans(big, 20, 300, 400);
  assert.ok(spans.length <= 15, `got ${spans.length}`);
  for (const s of spans) {
    assert.ok(s.x0 >= 0 && s.x1 <= 400 && s.y >= 0 && s.y + s.height <= 300);
  }
});

test('formatMetres', () => {
  assert.equal(g.formatMetres(84.6), '85 m');
  assert.equal(g.formatMetres(1234), '1.2 km');
  assert.equal(g.formatMetres(12_500), '13 km');
});
