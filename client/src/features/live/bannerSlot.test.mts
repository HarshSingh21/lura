import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BANNER_GAP, BANNER_MAX_WIDTH, bannerSlot, MAP_INSET, pushDown } from './bannerSlot.ts';

const ACTIONS = { width: 215, height: 38 }; // Draw + Share location on a desktop

const overlaps = (a: { x: number; y: number; w: number; h: number }, b: typeof a) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test('at 1440 px the banner sits beside the action row, clear of it', () => {
  const mapWidth = 1440 - 224 - 328; // sidebar and rail
  const slot = bannerSlot(mapWidth, ACTIONS);
  assert.equal(slot.kind, 'beside');
  if (slot.kind !== 'beside') return;
  assert.equal(slot.width, BANNER_MAX_WIDTH);
  const banner = { x: mapWidth - slot.right - slot.width, y: slot.top, w: slot.width, h: 60 };
  const row = { x: MAP_INSET, y: MAP_INSET, w: ACTIONS.width, h: ACTIONS.height };
  assert.equal(overlaps(banner, row), false);
  assert.equal(pushDown(slot, 60), 0);
});

test('a narrower desktop map shrinks the banner before it gives up the corner', () => {
  const slot = bannerSlot(620, ACTIONS);
  assert.equal(slot.kind, 'beside');
  if (slot.kind === 'beside') assert.equal(slot.width, 620 - MAP_INSET * 2 - ACTIONS.width - BANNER_GAP);
});

test('on a 390 px phone it goes under the action row and pushes what opens there down', () => {
  const slot = bannerSlot(390, { width: 194, height: 34 });
  assert.equal(slot.kind, 'below');
  if (slot.kind !== 'below') return;
  assert.equal(slot.top, MAP_INSET + 34 + BANNER_GAP);
  const banner = { x: slot.left, y: slot.top, w: 390 - slot.left - slot.right, h: 70 };
  const row = { x: MAP_INSET, y: MAP_INSET, w: 194, h: 34 };
  assert.equal(overlaps(banner, row), false);
  assert.equal(pushDown(slot, 70), 70 + BANNER_GAP);
});

test('before the action row is laid out the banner stays out of its way', () => {
  const slot = bannerSlot(900, { width: 0, height: 0 });
  assert.equal(slot.kind, 'below');
  assert.ok(slot.top >= MAP_INSET + 38);
  assert.equal(pushDown(null, 70), 0);
});
