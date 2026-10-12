import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateLabelWidth, placeLabels, type LabelBox } from './labels.ts';

const box = (id: string, cx: number, top: number, extra: Partial<LabelBox> = {}): LabelBox => ({
  id,
  cx,
  top,
  width: 80,
  height: 24,
  extent: 50,
  ...extra,
});

test('labels that do not touch are all shown', () => {
  const shown = placeLabels([box('a', 100, 100), box('b', 200, 100), box('c', 100, 140)]);
  assert.deepEqual([...shown].sort(), ['a', 'b', 'c']);
});

test('of two overlapping labels, the larger fence keeps its name', () => {
  const shown = placeLabels([box('shop', 100, 100, { extent: 20 }), box('district', 130, 105, { extent: 400 })]);
  assert.deepEqual([...shown], ['district']);
});

test('the selected fence always shows, even over a bigger one', () => {
  const shown = placeLabels([box('big', 100, 100, { extent: 400 }), box('picked', 110, 100, { selected: true })]);
  assert.ok(shown.has('picked'));
  assert.ok(!shown.has('big'));
});

test('ties keep the original order, so panning does not shuffle names', () => {
  const shown = placeLabels([box('first', 100, 100), box('second', 120, 100)]);
  assert.deepEqual([...shown], ['first']);
});

test('a dense grid shows no overlapping pair', () => {
  const boxes: LabelBox[] = [];
  for (let i = 0; i < 30; i += 1) boxes.push(box(`s${i}`, (i % 6) * 55, Math.floor(i / 6) * 30));
  const shown = placeLabels(boxes);
  const kept = boxes.filter((b) => shown.has(b.id));
  for (const a of kept) {
    for (const b of kept) {
      if (a === b) continue;
      const overlap = Math.abs(a.cx - b.cx) < (a.width + b.width) / 2 && Math.abs(a.top - b.top) < (a.height + b.height) / 2;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
  assert.ok(kept.length >= 6, 'too aggressive: fewer than one label per column');
});

test('width estimate grows with the name and the badge, and is capped', () => {
  assert.ok(estimateLabelWidth('Gym') < estimateLabelWidth('Cubbon Park'));
  assert.ok(estimateLabelWidth('Gym', '120m') > estimateLabelWidth('Gym'));
  assert.equal(estimateLabelWidth('x'.repeat(100)), 180);
});
