import { test } from 'node:test';
import assert from 'node:assert/strict';

import { inQuietHours, minutesInZone } from './quiet.ts';

// 2026-03-01 20:00 UTC is 01:30 the next day in Kolkata (UTC+5:30).
const at = Date.UTC(2026, 2, 1, 20, 0);

test('reads the wall clock in the viewer’s own timezone', () => {
  assert.equal(minutesInZone(at, 'UTC'), 20 * 60);
  assert.equal(minutesInZone(at, 'Asia/Kolkata'), 90);
  assert.equal(minutesInZone(at, 'Not/AZone'), 20 * 60, 'an unknown zone falls back to UTC, like the server');
});

test('a window that wraps midnight', () => {
  const q = { from: '22:30', to: '07:00', tz: 'Asia/Kolkata' };
  assert.equal(inQuietHours(q, at), true);
  assert.equal(inQuietHours({ ...q, tz: 'UTC' }, at), false, '20:00 UTC is before 22:30');
});

test('a same-day window is half-open, like the server', () => {
  const q = { from: '20:00', to: '21:00', tz: 'UTC' };
  assert.equal(inQuietHours(q, at), true);
  assert.equal(inQuietHours({ ...q, from: '19:00', to: '20:00' }, at), false);
});

test('off when unset, malformed or empty-length', () => {
  assert.equal(inQuietHours(null, at), false);
  assert.equal(inQuietHours({ from: '', to: '07:00' }, at), false);
  assert.equal(inQuietHours({ from: '25:00', to: '07:00' }, at), false);
  assert.equal(inQuietHours({ from: '08:00', to: '08:00' }, at), false);
});
