// A pending reminder over time, as hooks/useReminders.ts drives it: a 1 s tick
// takes the due cards (store.takeDueChimes = dueCards + markChimed) and rings.
// The card never times out, rings every REMIND_EVERY_MS while pending, comes
// back after a failed acknowledgement and keeps ringing, and stops for good the
// moment any session acknowledges it.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ReminderRecord } from '../../api/types.ts';
import {
  acknowledge,
  beginAck,
  commitAck,
  DEFAULT_REMIND_EVERY_MS,
  dueCards,
  EMPTY_REMINDERS,
  markChimed,
  reconcile,
  repeatAction,
  rollbackAck,
  upsert,
  type RemindersState,
} from './reminders.ts';

const HARSH = 'usr_harsh';
const T0 = Date.UTC(2026, 9, 12, 8, 51, 0);
const TICK = 1_000;

function row(over: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'rem_milk',
    userId: HARSH,
    ownerId: HARSH,
    noteIds: ['nte_milk'],
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    trigger: 'passby',
    kind: 'note',
    title: 'buy milk',
    body: 'at Grocery',
    subjectUserId: HARSH,
    subjectName: 'Harsh',
    eventId: 'evt_1',
    createdAt: '2026-10-12T08:51:00Z',
    status: 'pending',
    ...over,
  };
}

/** tab is one browser tab's reminder state and its repeat loop. */
function tab() {
  const t = {
    state: EMPTY_REMINDERS as RemindersState,
    chimes: [] as number[],
    run(from: number, to: number, everyMs = DEFAULT_REMIND_EVERY_MS) {
      for (let now = from; now <= to; now += TICK) {
        const due = dueCards(t.state, now, everyMs);
        if (due.length === 0) continue;
        t.state = markChimed(t.state, due.map((c) => c.id), now);
        t.chimes.push(now);
      }
    },
  };
  return t;
}

test('a pending card is sticky: an hour later it is still there and has rung once a minute', () => {
  const a = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  a.run(T0 + TICK, T0 + 60 * 60_000);
  assert.equal(a.state.cards.length, 1, 'no timeout');
  assert.equal(a.chimes.length, 60);
  for (let i = 1; i < a.chimes.length; i++) assert.equal(a.chimes[i]! - a.chimes[i - 1]!, DEFAULT_REMIND_EVERY_MS);
});

test('the interval follows REMIND_EVERY_MS', () => {
  const a = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  a.run(T0 + TICK, T0 + 60_000, 5_000);
  assert.equal(a.chimes.length, 12);
});

test('a failed acknowledgement puts the card back and it keeps ringing; a good one stops it', () => {
  const a = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  a.run(T0 + TICK, T0 + 90_000); // one repeat at +60 s

  const began = beginAck(a.state, 'rem_milk');
  a.state = began.state;
  a.run(T0 + 91_000, T0 + 130_000);
  assert.equal(a.chimes.length, 1, 'no chime while the ack is in flight');

  a.state = rollbackAck(a.state, 'rem_milk'); // the server said 500
  assert.equal(a.state.cards.length, 1);
  a.run(T0 + 131_000, T0 + 200_000);
  assert.ok(a.chimes.length >= 2, 'ringing resumed after the rollback');

  a.state = commitAck(beginAck(a.state, 'rem_milk').state, 'rem_milk', T0 + 201_000);
  const before = a.chimes.length;
  a.run(T0 + 202_000, T0 + 2 * 60 * 60_000);
  assert.equal(a.chimes.length, before);
  assert.equal(a.state.cards.length, 0);
});

test('acknowledged in one tab: the other tab stops ringing at its reminder_ack frame and stays quiet after reload', () => {
  const a = tab();
  const b = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  b.state = upsert(b.state, row(), HARSH, T0).state;
  a.run(T0 + TICK, T0 + 61_000);
  b.run(T0 + TICK, T0 + 61_000);

  a.state = commitAck(beginAck(a.state, 'rem_milk').state, 'rem_milk', T0 + 62_000);
  b.state = acknowledge(b.state, 'rem_milk', T0 + 62_000); // the frame
  const bBefore = b.chimes.length;
  b.run(T0 + 63_000, T0 + 10 * 60_000);
  assert.equal(b.chimes.length, bBefore);

  // Tab B reloads with a pending list that is now empty: still nothing.
  const reloaded = reconcile(EMPTY_REMINDERS, [], T0 + 11 * 60_000, HARSH, T0 + 11 * 60_000);
  assert.equal(reloaded.state.cards.length, 0);
});

test('acknowledged elsewhere while this tab was offline: the reconnect list clears it', () => {
  const a = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  const res = reconcile(a.state, [], T0 + 5 * 60_000, HARSH, T0 + 5 * 60_000);
  assert.deepEqual(res.removed, ['rem_milk']);
  a.state = res.state;
  a.run(T0 + 5 * 60_000, T0 + 30 * 60_000);
  assert.equal(a.chimes.length, 0);
});

test('mute and quiet hours silence the repeat but never remove the card', () => {
  assert.equal(repeatAction({ quiet: false, visible: true, muted: true }), 'muted');
  assert.equal(repeatAction({ quiet: true, visible: true, muted: false }), 'quiet');
  assert.equal(repeatAction({ quiet: false, visible: false, muted: false }), 'desktop');
  assert.equal(repeatAction({ quiet: false, visible: true, muted: false }), 'sound');
  // The schedule is the card's, whatever the action: it is still pending.
  const a = tab();
  a.state = upsert(a.state, row(), HARSH, T0).state;
  a.run(T0 + TICK, T0 + 10 * 60_000);
  assert.equal(a.state.cards.length, 1);
});
