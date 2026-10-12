import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GeoEvent, Reminder, ReminderRecord } from '../../api/types.ts';
import { fromReminder, ingest, setReminderStatus, filterItems, chimeFor } from './model.ts';
import {
  DEFAULT_REMIND_EVERY_MS,
  EMPTY_REMINDERS,
  MIN_REMIND_EVERY_MS,
  acknowledge,
  beginAck,
  cardFrom,
  commitAck,
  dueCards,
  markChimed,
  nextDueIn,
  reconcile,
  resolveEveryMs,
  rollbackAck,
  stackView,
  upsert,
  type RemindersState,
  repeatAction,
} from './reminders.ts';

const HARSH = 'usr_harsh';
const NISHTHA = 'usr_nishtha';
const T0 = Date.UTC(2026, 9, 12, 8, 51, 0);

/** A row from GET /api/v1/reminders. */
function record(over: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'rem_1',
    userId: HARSH,
    ownerId: HARSH,
    noteIds: ['nte_1'],
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

const EVENT: GeoEvent = {
  id: 'evt_1',
  userId: HARSH,
  deviceId: 'dev_h',
  placeId: 'plc_grocery',
  placeName: 'Grocery',
  trigger: 'passby',
  ts: '2026-10-12T08:51:00Z',
  point: { lat: 12.97, lon: 77.59 },
  speedMps: 9,
  subjectUserId: HARSH,
  subjectName: 'Harsh',
};

/** The same reminder as the live `notify` frame delivers it. */
function frame(over: Partial<Reminder> = {}): Reminder & { id: string; status: 'pending' | 'acknowledged' } {
  return {
    id: 'rem_1',
    status: 'pending',
    userId: HARSH,
    ownerId: HARSH,
    eventId: 'evt_1',
    createdAt: '2026-10-12T08:51:00Z',
    title: 'buy milk',
    body: 'at Grocery',
    trigger: 'passby',
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    deviceId: 'dev_h',
    noteIds: ['nte_1'],
    tags: [],
    priority: 0,
    ts: '2026-10-12T08:51:00Z',
    kind: 'note',
    event: EVENT,
    ...over,
  } as Reminder & { id: string; status: 'pending' | 'acknowledged' };
}

function ids(state: RemindersState): string[] {
  return state.cards.map((c) => c.id);
}

test('a pending record becomes one card, however often and however it arrives', () => {
  const res = upsert(EMPTY_REMINDERS, frame(), HARSH, T0);
  assert.equal(res.added, true);
  assert.deepEqual(ids(res.state), ['rem_1']);
  assert.deepEqual(res.card?.point, EVENT.point, 'the live frame knows where it happened');
  // The pending list read on reconnect, then a replayed notify frame: still one.
  const again = upsert(res.state, record({ title: 'buy milk (2L)' }), HARSH, T0 + 5_000);
  assert.equal(again.added, false);
  assert.deepEqual(ids(again.state), ['rem_1']);
  assert.equal(again.state.cards[0]!.title, 'buy milk (2L)');
  assert.equal(upsert(again.state, frame(), HARSH, T0 + 6_000).added, false);
  // Re-wording does not restart the chime schedule.
  assert.equal(again.state.cards[0]!.lastChimeAt, T0);
});

test('my own crossing is not a person on the card; a peer crossing and a sender are', () => {
  const own = cardFrom(record(), HARSH, T0)!;
  assert.equal(own.subjectUserId, undefined);
  assert.equal(own.fromName, undefined);
  assert.equal(own.at, Date.UTC(2026, 9, 12, 8, 51, 0));

  const forNishtha = cardFrom(
    frame({
      userId: NISHTHA,
      fromUserId: HARSH,
      fromName: 'Harsh',
      event: { ...EVENT, subjectUserId: NISHTHA, subjectName: 'Nishtha' },
    }),
    NISHTHA,
    T0,
  )!;
  assert.equal(forNishtha.fromName, 'Harsh');
  assert.equal(forNishtha.subjectUserId, undefined);

  const watched = cardFrom(record({ kind: 'watch', subjectUserId: NISHTHA, subjectName: 'Nishtha' }), HARSH, T0)!;
  assert.equal(watched.kind, 'watch');
  assert.equal(watched.subjectName, 'Nishtha');
  assert.equal(watched.subjectUserId, NISHTHA);
});

test('an ack notification for the owner is not a sticky card', () => {
  assert.equal(cardFrom(record({ kind: 'ack', title: 'Nishtha acknowledged buy milk' }), HARSH, T0), null);
  // The server sends them already acknowledged; even a pending one is not a card.
  const res = upsert(EMPTY_REMINDERS, record({ kind: 'ack', eventId: '' }), HARSH, T0);
  assert.equal(res.state.cards.length, 0);
});

test('a watch card does not repeat its title as its body', () => {
  const watch = cardFrom(
    record({ kind: 'watch', title: 'Nishtha Dev left Grocery', body: 'Nishtha Dev left Grocery', noteIds: [] }),
    HARSH,
    T0,
  );
  assert.equal(watch?.title, 'Nishtha Dev left Grocery');
  assert.equal(watch?.body, undefined);
  assert.equal(cardFrom(record({ title: 'Passing Grocery', body: 'buy milk' }), HARSH, T0)?.body, 'buy milk');
});

test('cards are newest first', () => {
  let s = EMPTY_REMINDERS;
  s = upsert(s, record({ id: 'a', createdAt: '2026-10-12T08:00:00Z' }), HARSH, T0).state;
  s = upsert(s, record({ id: 'c', createdAt: '2026-10-12T09:00:00Z' }), HARSH, T0).state;
  s = upsert(s, record({ id: 'b', createdAt: '2026-10-12T08:30:00Z' }), HARSH, T0).state;
  assert.deepEqual(ids(s), ['c', 'b', 'a']);
});

test('an ack from any session clears the card and keeps it cleared', () => {
  let s = upsert(EMPTY_REMINDERS, record(), HARSH, T0).state;
  s = acknowledge(s, 'rem_1', T0 + 60_000);
  assert.equal(s.cards.length, 0);
  // A notify frame or a pending list that was already in flight cannot revive it.
  assert.equal(upsert(s, record(), HARSH, T0 + 61_000).state.cards.length, 0);
  assert.equal(reconcile(s, [record()], T0 + 61_000, HARSH, T0 + 62_000).state.cards.length, 0);
  // An acknowledged record also clears.
  const t = upsert(EMPTY_REMINDERS, record(), HARSH, T0).state;
  const cleared = upsert(t, record({ status: 'acknowledged', ackedAt: '2026-10-12T08:52:00Z' }), HARSH, T0);
  assert.equal(cleared.state.cards.length, 0);
  assert.equal(cleared.state.acked['rem_1'], Date.UTC(2026, 9, 12, 8, 52, 0));
});

test('acknowledging is optimistic and rolls back on failure', () => {
  const s = upsert(EMPTY_REMINDERS, record(), HARSH, T0).state;
  const began = beginAck(s, 'rem_1');
  assert.equal(began.state.cards.length, 0, 'the card leaves at once');
  assert.ok(began.card);
  // While in flight, a replay does not bring it back.
  assert.equal(upsert(began.state, record(), HARSH, T0).state.cards.length, 0);

  const rolled = rollbackAck(began.state, 'rem_1');
  assert.deepEqual(ids(rolled), ['rem_1'], 'a refusal puts it back');
  assert.deepEqual(rolled.inflight, {});

  const committed = commitAck(began.state, 'rem_1', T0 + 1);
  assert.equal(committed.cards.length, 0);
  assert.deepEqual(committed.inflight, {});
  assert.equal(committed.acked['rem_1'], T0 + 1);

  // Refused here, but acknowledged in another tab meanwhile: it stays gone.
  const elsewhere = acknowledge(began.state, 'rem_1', T0 + 2);
  assert.equal(rollbackAck(elsewhere, 'rem_1').cards.length, 0);
  assert.equal(beginAck(EMPTY_REMINDERS, 'nope').card, undefined);
});

test('the pending list adds what is missing and drops what was acknowledged elsewhere', () => {
  let s = upsert(EMPTY_REMINDERS, record({ id: 'old' }), HARSH, T0).state;
  // A card that arrives over the socket after the list was requested is kept.
  const requestedAt = T0 + 10_000;
  s = upsert(s, record({ id: 'fresh' }), HARSH, requestedAt + 500).state;
  const res = reconcile(s, [record({ id: 'new' })], requestedAt, HARSH, requestedAt + 1_000);
  assert.deepEqual(res.removed, ['old']);
  assert.deepEqual(
    res.added.map((c) => c.id),
    ['new'],
  );
  assert.deepEqual(ids(res.state).sort(), ['fresh', 'new']);
  assert.ok(res.state.acked['old'] !== undefined);
});

test('the chime repeats per card every interval', () => {
  const every = 60_000;
  let s = upsert(EMPTY_REMINDERS, record({ id: 'a' }), HARSH, T0).state;
  s = upsert(s, record({ id: 'b' }), HARSH, T0 + 20_000).state;

  assert.deepEqual(dueCards(s, T0 + 59_999, every), []);
  assert.equal(nextDueIn(s, T0 + 30_000, every), 30_000);
  const due = dueCards(s, T0 + 60_000, every);
  assert.deepEqual(
    due.map((c) => c.id),
    ['a'],
  );
  s = markChimed(s, ['a'], T0 + 60_000);
  assert.deepEqual(dueCards(s, T0 + 60_000, every), [], 'one chime per card per interval');
  assert.deepEqual(
    dueCards(s, T0 + 80_000, every).map((c) => c.id),
    ['b'],
  );
  // Both overdue (a tab that was asleep): the most overdue first.
  assert.deepEqual(
    dueCards(s, T0 + 200_000, every).map((c) => c.id),
    ['b', 'a'],
  );
  // Acknowledged: nothing more to ring.
  s = acknowledge(acknowledge(s, 'a'), 'b');
  assert.deepEqual(dueCards(s, T0 + 999_999, every), []);
  assert.equal(nextDueIn(s, T0, every), null);
});

test('the repeat interval: test hook, then env, then 60 s, never below the floor', () => {
  assert.equal(resolveEveryMs(undefined, undefined), DEFAULT_REMIND_EVERY_MS);
  assert.equal(DEFAULT_REMIND_EVERY_MS, 60_000);
  assert.equal(resolveEveryMs(5_000, '20000'), 5_000);
  assert.equal(resolveEveryMs('3000', undefined), 3_000);
  assert.equal(resolveEveryMs(undefined, '20000'), 20_000);
  assert.equal(resolveEveryMs(10, undefined), MIN_REMIND_EVERY_MS);
  assert.equal(resolveEveryMs(-1, 'nonsense'), DEFAULT_REMIND_EVERY_MS);
  // A too-small interval passed straight to the scheduler is clamped as well.
  const s = upsert(EMPTY_REMINDERS, record(), HARSH, T0).state;
  assert.deepEqual(dueCards(s, T0 + 10, 1), []);
});

test('a stack shows the newest card and folds the rest', () => {
  let s = EMPTY_REMINDERS;
  for (const id of ['a', 'b', 'c'])
    s = upsert(s, record({ id, createdAt: `2026-10-12T08:5${ids(s).length}:00Z` }), HARSH, T0).state;
  const folded = stackView(s.cards, false);
  assert.deepEqual(
    folded.shown.map((c) => c.id),
    ['c'],
  );
  assert.equal(folded.hidden, 2);
  assert.equal(stackView(s.cards, true).shown.length, 3);
  assert.equal(stackView(s.cards.slice(0, 1), false).hidden, 0);
});

test('notification entries carry the reminder status and survive replays', () => {
  const first = ingest([], fromReminder(frame(), HARSH, T0));
  assert.equal(first.announce, true);
  assert.equal(first.item.status, 'pending');
  assert.equal(first.item.reminderId, 'rem_1');
  assert.equal(first.item.id, 'evt_1', 'keyed by the crossing, so the geo frame folds in');

  let items = setReminderStatus(first.items, 'rem_1', 'acknowledged', T0 + 60_000);
  assert.equal(items[0]!.status, 'acknowledged');
  assert.equal(items[0]!.ackedAt, T0 + 60_000);
  // A replayed pending copy does not reopen it.
  items = ingest(items, fromReminder(record(), HARSH, T0)).items;
  assert.equal(items.length, 1, 'the stored row lands on the same entry as the frame');
  assert.equal(items[0]!.status, 'acknowledged');
  assert.deepEqual(filterItems(items, 'pending'), []);
  assert.equal(filterItems(items, 'all').length, 1);

  // The owner's "Nishtha acknowledged buy milk" is its own entry with its own chime.
  const ack = fromReminder(
    record({
      id: 'rem_ack',
      kind: 'ack',
      eventId: '',
      title: 'Nishtha acknowledged buy milk',
      status: 'acknowledged',
      ackedBy: NISHTHA,
    }),
    HARSH,
    T0,
  );
  assert.equal(ack.kind, 'ack');
  assert.equal(ack.status, undefined);
  assert.notEqual(ack.id, 'evt_1');
  assert.deepEqual(chimeFor(ack), { kind: 'dwell', watched: false });
  assert.equal(ingest(items, ack).items.length, 2);
});

test('a stored row and a live frame are one entry even when they name the crossing differently', () => {
  const live = ingest([], fromReminder(frame({ event: { ...EVENT, id: 'geo_live' }, eventId: 'geo_live' }), HARSH, T0));
  const row = ingest(live.items, fromReminder(record({ eventId: 'evt_other' }), HARSH, T0));
  assert.equal(row.items.length, 1);
  assert.equal(row.announce, false, 'already announced');
});

test('a due repeat is held back in quiet hours, chimes in front, notifies the desktop otherwise', () => {
  assert.equal(repeatAction({ quiet: true, visible: true, muted: false }), 'quiet');
  assert.equal(repeatAction({ quiet: true, visible: false, muted: false }), 'quiet');
  assert.equal(repeatAction({ quiet: false, visible: true, muted: false }), 'sound');
  assert.equal(repeatAction({ quiet: false, visible: true, muted: true }), 'muted');
  assert.equal(repeatAction({ quiet: false, visible: false, muted: true }), 'desktop');
});
