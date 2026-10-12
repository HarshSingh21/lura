import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Peer } from '../people/types.ts';
import { reminderHold } from './reminders.ts';

const peer = (over: Partial<Peer> = {}): Peer => ({
  id: 'con_1',
  userId: 'harsh',
  peerId: 'nishtha',
  peerName: 'Nishtha Dev',
  peerEmail: 'nishtha@lura.local',
  status: 'accepted',
  sharing: true,
  createdAt: '',
  updatedAt: '',
  watchingMe: true,
  sharingWithMe: true,
  ...over,
});

test('a note on my own movement is never on hold', () => {
  assert.equal(reminderHold({ userId: 'harsh', watchUserId: '' }, []), undefined);
  assert.equal(reminderHold({ userId: 'harsh', watchUserId: 'harsh' }, []), undefined);
});

test('a note on a person sharing with me is armed', () => {
  assert.equal(reminderHold({ userId: 'harsh', watchUserId: 'nishtha' }, [peer()]), undefined);
});

test('a paused peer puts the note on hold, by name', () => {
  assert.equal(
    reminderHold({ userId: 'harsh', watchUserId: 'nishtha' }, [peer({ sharingWithMe: false })]),
    'On hold · Nishtha paused sharing with you',
  );
});

test('a removed or never-accepted peer puts the note on hold', () => {
  const removed = 'On hold · the person it watches is no longer connected';
  assert.equal(reminderHold({ userId: 'harsh', watchUserId: 'nishtha' }, []), removed);
  assert.equal(reminderHold({ userId: 'harsh', watchUserId: 'nishtha' }, [peer({ status: 'pending_out' })]), removed);
});
