import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Peer } from '../people/types.ts';
import type { Note } from '../../api/types.ts';
import { reminderHold, upcomingNotes } from './reminders.ts';

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

test('a note that has gone off and waits on a card is listed first, as waiting, not as armed', () => {
  const note = (id: string, over: Partial<Note> = {}): Note => ({
    id, userId: 'harsh', placeId: 'plc_1', text: id, trigger: 'passby', tags: [], done: false,
    watchUserId: '', notifyUserIds: [], createdAt: '', updatedAt: '', ...over,
  }) as Note;
  const notes = [note('held', { watchUserId: 'ravi' }), note('armed'), note('milk'), note('done', { done: true }), note('loose', { placeId: '' })];
  const list = upcomingNotes(notes, [peer()], [{ noteIds: ['milk'] }, { noteIds: undefined }]);
  assert.deepEqual(list.map((u) => [u.note.id, u.waiting, !!u.hold]), [
    ['milk', true, false],
    ['armed', false, false],
    ['held', false, true],
  ]);
  // With nothing pending, nothing waits.
  assert.ok(upcomingNotes(notes, [peer()]).every((u) => !u.waiting));
  assert.equal(upcomingNotes(notes, [peer()], [], 1).length, 1);
});

test('a note waiting on a card whose watched peer paused says both', () => {
  const milk = {
    id: 'milk', userId: 'harsh', placeId: 'plc_1', text: 'buy milk', trigger: 'arrive', tags: [], done: false,
    watchUserId: 'nishtha', notifyUserIds: [], createdAt: '', updatedAt: '',
  } as unknown as Note;
  const [u] = upcomingNotes([milk], [peer({ sharingWithMe: false })], [{ noteIds: ['milk'] }]);
  assert.equal(u?.waiting, true);
  assert.equal(u?.hold, 'On hold · Nishtha paused sharing with you');
  const [armed] = upcomingNotes([milk], [peer()], [{ noteIds: ['milk'] }]);
  assert.deepEqual([armed?.waiting, armed?.hold], [true, undefined]);
});

test('a note that went off just before its person was removed is waiting and on hold', () => {
  const milk = {
    id: 'milk', userId: 'harsh', placeId: 'plc_1', text: 'buy milk', trigger: 'passby', tags: [], done: false,
    watchUserId: 'nishtha', notifyUserIds: [], createdAt: '', updatedAt: '',
  } as unknown as Note;
  const [u] = upcomingNotes([milk], [], [{ noteIds: ['milk'] }]);
  assert.equal(u?.waiting, true);
  assert.equal(u?.hold, 'On hold · the person it watches is no longer connected');
  // While she still shares, it only waits.
  const [still] = upcomingNotes([milk], [peer()], [{ noteIds: ['milk'] }]);
  assert.deepEqual([still?.waiting, still?.hold], [true, undefined]);
});
