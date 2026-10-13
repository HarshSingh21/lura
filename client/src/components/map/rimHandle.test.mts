import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROL_LANE, rimDirection } from './rimHandle.ts';

const PHONE = { w: 390, h: 730 };

test('a circle well inside the map keeps its handle due east', () => {
  assert.deepEqual(rimDirection({ x: 150, y: 300 }, 60, PHONE.w, PHONE.h), { x: 1, y: 0 });
});

test('east under the control column: the handle moves to the west side', () => {
  // The run that found it: centre 245 px, radius 100 px on a 390 px phone → east at 345, under the buttons.
  const d = rimDirection({ x: 245, y: 460 }, 100, PHONE.w, PHONE.h);
  assert.deepEqual(d, { x: -1, y: 0 });
  assert.ok(245 + 100 > PHONE.w - CONTROL_LANE);
});

test('a circle wider than the map on both sides tries south, then north', () => {
  assert.deepEqual(rimDirection({ x: 195, y: 200 }, 300, PHONE.w, PHONE.h), { x: 0, y: 1 });
  assert.deepEqual(rimDirection({ x: 195, y: 500 }, 300, PHONE.w, PHONE.h), { x: 0, y: -1 });
});

test('nowhere clear: east, as before', () => {
  assert.deepEqual(rimDirection({ x: 195, y: 365 }, 2000, PHONE.w, PHONE.h), { x: 1, y: 0 });
});
