import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CONTROLS_LANE, PHONE_STACK_BOTTOM, PHONE_STACK_MAX_WIDTH, WIDE_STACK_WIDTH, coversRail, railTopPadding, stackSlot } from './stackSlot.ts';

// The shell's tokens (theme/tokens.ts layout and space).
const M = { topBarHeight: 58, railWidth: 328, historyRailWidth: 360, inset: 11, wideInset: 18, gap: 8 };
const SIDEBAR = 224;

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** box is where a stack `height` tall lands in a viewport, from its slot. */
function box(slot: ReturnType<typeof stackSlot>, vw: number, vh: number, height: number): Box {
  const w = slot.width ?? vw - (slot.left ?? 0) - slot.right;
  const x = vw - slot.right - w;
  const y = slot.top === 'auto' || slot.top === undefined ? vh - (slot.bottom ?? 0) - height : slot.top;
  return { x, y, w, h: height };
}

test('on the desktop Live map the stack covers the right rail, not the map', () => {
  const s = stackSlot('desktop', '/', M);
  assert.deepEqual(s, { top: 66, right: 11, width: 306 });
  const b = box(s, 1440, 900, 300);
  assert.ok(b.x >= 1440 - M.railWidth, `stack starts at ${b.x}, inside the map`);
});

test('on desktop History the stack leaves the timeline and its day picker alone', () => {
  for (const vw of [1080, 1440, 1920]) {
    const s = stackSlot('desktop', '/history', M);
    // A stack of three folded cards' height, and the expanded maximum.
    for (const height of [190, 470]) {
      const b = box(s, vw, 900, height);
      const rail: Box = { x: vw - M.historyRailWidth, y: M.topBarHeight, w: M.historyRailWidth, h: 900 - M.topBarHeight };
      const map: Box = { x: SIDEBAR, y: M.topBarHeight, w: vw - SIDEBAR - M.historyRailWidth, h: 900 - M.topBarHeight };
      // The map's basemap button sits in its top-right corner.
      const basemap: Box = { x: map.x + map.w - 56, y: map.y + 16, w: 40, h: 40 };
      assert.ok(!overlaps(b, rail), `${vw}px, ${height}px tall: covers the timeline`);
      assert.ok(!overlaps(b, basemap), `${vw}px, ${height}px tall: covers the basemap button`);
      assert.ok(b.x >= map.x && b.x + b.w <= map.x + map.w, `${vw}px: not within the map (${JSON.stringify(b)})`);
    }
  }
  // A nested History path is History too; a path that merely starts with the word is not.
  assert.equal(stackSlot('desktop', '/history/2026-10-12', M).top, 'auto');
  assert.equal(stackSlot('desktop', '/historyx', M).top, 66);
});

test('the desktop Live rail starts below the sticky cards over it, and only there', () => {
  assert.equal(coversRail('desktop', '/'), true);
  assert.equal(coversRail('desktop', '/people'), true);
  assert.equal(coversRail('desktop', '/history'), false);
  assert.equal(coversRail('wide', '/'), false);
  assert.equal(coversRail('phone', '/'), false);

  const base = 18;
  assert.equal(railTopPadding(0, base, M), base, 'no card up: the rail keeps its own padding');
  // One folded card, a fractional height from the browser, and an expanded stack.
  for (const cover of [128, 160.5, 470]) {
    const pad = railTopPadding(cover, base, M);
    // The rail's scroll content starts under the top bar; the stack starts M.gap below it.
    const s = stackSlot('desktop', '/', M);
    const stackBottom = (s.top as number) - M.topBarHeight + cover;
    assert.ok(pad >= stackBottom + base, `${cover}px of cards: first row at ${pad}, cards end at ${stackBottom}`);
    assert.ok(pad <= stackBottom + base + 1, `${cover}px of cards: ${pad - stackBottom}px of empty gap`);
  }
});

test('wide and phone layouts keep their places on every screen', () => {
  for (const path of ['/', '/history', '/places']) {
    assert.deepEqual(stackSlot('wide', path, M), { top: 66, right: 18, width: WIDE_STACK_WIDTH });
    assert.deepEqual(stackSlot('phone', path, M), { top: 'auto', left: 11, right: CONTROLS_LANE, bottom: PHONE_STACK_BOTTOM, maxWidth: PHONE_STACK_MAX_WIDTH });
  }
});
