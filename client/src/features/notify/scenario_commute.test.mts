import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReminderRecord } from '../../api/types.ts';
import { inQuietHours } from './quiet.ts';
import { EMPTY_REMINDERS, acknowledge, beginAck, commitAck, dueCards, reconcile, repeatAction, upsert, type RemindersState } from './reminders.ts';

/**
 * The commute (release spec §6) as two of Harsh's sessions see it: his phone
 * gets the live frame, his laptop only ever reads the pending list. The card
 * survives a reconnect and a server restart (the list still has it), rings on
 * its schedule, and one Acknowledge clears it in both — for good.
 */

const HARSH = 'usr_harsh';
const T0 = Date.UTC(2026, 9, 13, 8, 51, 0);
const EVERY = 60_000;

const milk: ReminderRecord = {
  id: 'rem_milk',
  userId: HARSH,
  ownerId: HARSH,
  noteIds: ['nte_milk'],
  placeId: 'plc_grocery',
  placeName: 'Grocery',
  trigger: 'passby',
  kind: 'note',
  title: 'Passed by Grocery',
  body: 'buy milk',
  subjectUserId: HARSH,
  subjectName: 'Harsh',
  eventId: 'geo_1',
  createdAt: '2026-10-13T08:51:00Z',
  status: 'pending',
};

const ids = (s: RemindersState) => s.cards.map((c) => c.id);

test('the commute: one card, through reconnects and a restart, until one Acknowledge clears it everywhere', () => {
  // The phone: the live frame makes the card and rings the first chime.
  const live = upsert(EMPTY_REMINDERS, milk, HARSH, T0);
  assert.equal(live.added, true);
  let phone = live.state;

  // The phone reconnects: the pending list repeats it, and nothing new rings.
  const reconnect = reconcile(phone, [milk], T0 + 5_000, HARSH, T0 + 5_100);
  assert.deepEqual(reconnect.added, []);
  assert.deepEqual(reconnect.removed, []);
  phone = reconnect.state;
  assert.deepEqual(ids(phone), ['rem_milk']);

  // The laptop signs in later and only reads the list.
  let laptop = reconcile(EMPTY_REMINDERS, [milk], T0 + 30_000, HARSH, T0 + 30_100).state;
  assert.deepEqual(ids(laptop), ['rem_milk']);

  // The server restarts; both reconnect and the list still has it.
  phone = reconcile(phone, [milk], T0 + 90_000, HARSH, T0 + 90_100).state;
  laptop = reconcile(laptop, [milk], T0 + 90_000, HARSH, T0 + 90_100).state;
  assert.deepEqual(ids(phone), ['rem_milk']);
  assert.deepEqual(ids(laptop), ['rem_milk']);

  // It keeps asking: due again a minute after the first chime.
  assert.deepEqual(
    dueCards(phone, T0 + EVERY, EVERY).map((c) => c.id),
    ['rem_milk'],
  );

  // Acknowledge on the phone; the server answers and the laptop gets the
  // reminder_ack frame.
  const ackedAt = T0 + 120_000;
  phone = beginAck(phone, 'rem_milk').state;
  assert.deepEqual(ids(phone), []);
  phone = commitAck(phone, 'rem_milk', ackedAt);
  laptop = acknowledge(laptop, 'rem_milk', ackedAt);
  assert.deepEqual(ids(laptop), []);

  // A stale frame or a list read just before the ack cannot bring it back.
  for (const s of [phone, laptop]) {
    assert.deepEqual(ids(upsert(s, milk, HARSH, ackedAt + 1).state), []);
    assert.deepEqual(ids(reconcile(s, [milk], ackedAt - 10, HARSH, ackedAt + 1).state), []);
    assert.deepEqual(dueCards(s, ackedAt + 10 * EVERY, EVERY), []);
  }
});

test('in the recipient’s quiet hours a pending card stays but does not ring', () => {
  const night = Date.UTC(2026, 9, 13, 23, 30, 0);
  const quiet = inQuietHours({ from: '22:00', to: '07:00', tz: 'UTC' }, night);
  assert.equal(quiet, true);
  assert.equal(repeatAction({ quiet, visible: true, muted: false }), 'quiet');
  assert.equal(repeatAction({ quiet, visible: false, muted: false }), 'quiet', 'no desktop notification either');
  // The same window is not hers in another timezone: 23:30 UTC is 05:00 in Kolkata — still quiet;
  // 23:30 UTC is 19:30 in New York — not.
  assert.equal(inQuietHours({ from: '22:00', to: '07:00', tz: 'Asia/Kolkata' }, night), true);
  assert.equal(inQuietHours({ from: '22:00', to: '07:00', tz: 'America/New_York' }, night), false);
  assert.equal(repeatAction({ quiet: false, visible: true, muted: false }), 'sound');

  const s = upsert(EMPTY_REMINDERS, milk, HARSH, night).state;
  assert.deepEqual(ids(s), ['rem_milk'], 'quiet hours never drop the card');
});
