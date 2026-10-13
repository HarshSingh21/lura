import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatCoolOff } from './format.ts';

test('a cool-off under a minute is written in seconds, not "0 min"', () => {
  assert.equal(formatCoolOff(15), '15 s per place/trigger');
});

test('whole minutes, and long ones, are minutes', () => {
  assert.equal(formatCoolOff(1800), '30 min per place/trigger');
  assert.equal(formatCoolOff(60), '1 min per place/trigger');
  assert.equal(formatCoolOff(725), '12 min per place/trigger');
});

test('minutes and seconds in between', () => {
  assert.equal(formatCoolOff(90), '1 min 30 s per place/trigger');
});

test('none, or nothing known', () => {
  assert.equal(formatCoolOff(0), 'none');
  assert.equal(formatCoolOff(undefined), 'none');
});
