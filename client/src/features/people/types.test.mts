import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Overview } from '@/api/types';

import { overviewNames } from './types.ts';

test("an overview names my devices and a sharing peer's, and nothing it predates", () => {
  const o = {
    user: { id: 'me' },
    devices: [{ id: 'my-phone' }],
    people: [{ peerId: 'her', devices: [{ id: 'her-phone', name: 'Phone' }] }, { peerId: 'him', devices: null }],
  } as unknown as Overview;
  assert.equal(overviewNames(o, { userId: 'me', deviceId: 'my-phone' }), true);
  assert.equal(overviewNames(o, { userId: 'me', deviceId: 'my-new-browser' }), false);
  assert.equal(overviewNames(o, { userId: 'her', deviceId: 'her-phone' }), true);
  // Her tablet, added after the page read the overview, arrives in the socket's snapshot.
  assert.equal(overviewNames(o, { userId: 'her', deviceId: 'her-tablet' }), false);
  // Another person's device is not hers because the ids match.
  assert.equal(overviewNames(o, { userId: 'him', deviceId: 'her-phone' }), false);
  // An overview without people names no peer's device.
  assert.equal(overviewNames({ ...o, people: undefined } as unknown as Overview, { userId: 'her', deviceId: 'her-phone' }), false);
});
