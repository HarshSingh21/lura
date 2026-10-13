import assert from 'node:assert/strict';
import { test } from 'node:test';

import { releaseDelta } from './releaseDelta.ts';

test('a short touch drag with no reported moves takes its travel from the release', () => {
  // Chrome sent touchstart at x=200 and touchend at x=214, nothing in between.
  assert.deepEqual(releaseDelta({ dx: 0, dy: 0 }, { pageX: 200, pageY: 400 }, { pageX: 214, pageY: 405 }), { dx: 14, dy: 5 });
});

test('a tap stays a tap', () => {
  assert.deepEqual(releaseDelta({ dx: 0, dy: 0 }, { pageX: 200, pageY: 400 }, { pageX: 200, pageY: 400 }), { dx: 0, dy: 0 });
});

test('moves that saw the whole drag are kept', () => {
  assert.deepEqual(releaseDelta({ dx: 60, dy: 0 }, { pageX: 200, pageY: 400 }, { pageX: 260, pageY: 400 }), { dx: 60, dy: 0 });
});

test('the release wins when the moves stopped short of it', () => {
  assert.deepEqual(releaseDelta({ dx: 30, dy: 0 }, { pageX: 200, pageY: 400 }, { pageX: 248, pageY: 400 }), { dx: 48, dy: 0 });
});

test('no positions, or broken ones, leave the moves alone', () => {
  assert.deepEqual(releaseDelta({ dx: 5, dy: 1 }, null, { pageX: 1, pageY: 1 }), { dx: 5, dy: 1 });
  assert.deepEqual(releaseDelta({ dx: 5, dy: 1 }, { pageX: 0, pageY: 0 }, { pageX: Number.NaN, pageY: 2 }), { dx: 5, dy: 1 });
  assert.deepEqual(releaseDelta({ dx: 5, dy: 1 }, { pageX: 0 }, { pageX: 9, pageY: 9 }), { dx: 5, dy: 1 });
});
