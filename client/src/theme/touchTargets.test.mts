import assert from 'node:assert/strict';
import { test } from 'node:test';

import { legibleSize, TOUCH_TARGET, wantsTouchTargets } from './touchTargets.ts';

test('tiny monospace labels grow on a phone, to 11 px at most', () => {
  assert.equal(legibleSize(9), 10.5);
  assert.equal(legibleSize(9.5), 11);
  assert.equal(legibleSize(10.5), 11);
});

test('type that is already readable is left alone', () => {
  assert.equal(legibleSize(11), 11);
  assert.equal(legibleSize(13.5), 13.5);
});

test('a phone-width browser gets finger-sized targets, even with a mouse', () => {
  assert.equal(wantsTouchTargets({ native: false, width: 390, coarsePointer: false, wide: 840 }), true);
});

test('a portrait tablet (the bottom-tab layout) gets them', () => {
  assert.equal(wantsTouchTargets({ native: false, width: 768, coarsePointer: true, wide: 840 }), true);
  assert.equal(wantsTouchTargets({ native: false, width: 768, coarsePointer: false, wide: 840 }), true);
});

test('the desktop control centre keeps its compact controls under a mouse', () => {
  assert.equal(wantsTouchTargets({ native: false, width: 1440, coarsePointer: false, wide: 840 }), false);
  assert.equal(wantsTouchTargets({ native: false, width: 840, coarsePointer: false, wide: 840 }), false);
});

test('a touch screen at desktop width, and every native build, get them', () => {
  assert.equal(wantsTouchTargets({ native: false, width: 1366, coarsePointer: true, wide: 840 }), true);
  assert.equal(wantsTouchTargets({ native: true, width: 1024, coarsePointer: false, wide: 840 }), true);
});

test('the target is the 44 px guideline', () => {
  assert.equal(TOUCH_TARGET, 44);
});
