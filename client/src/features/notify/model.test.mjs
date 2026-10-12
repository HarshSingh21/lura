// Run with: npm run test:unit (node --test; Node 23.6+ strips the TypeScript types).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_ITEMS,
  chimeFor,
  fromGeo,
  fromReminder,
  groupByDay,
  ingest,
  isPeerCrossing,
  markAllRead,
  mergeStored,
  unreadCount,
} from './model.ts';

const HARSH = 'usr_harsh';
const NISHTHA = 'usr_nishtha';

function geo(over = {}) {
  return {
    id: 'evt_1',
    userId: HARSH,
    deviceId: 'dev_n',
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    trigger: 'arrive',
    ts: '2026-10-12T10:00:00Z',
    point: { lat: 12.97, lon: 77.59 },
    speedMps: 0,
    subjectUserId: NISHTHA,
    subjectName: 'Nishtha',
    ...over,
  };
}

function reminder(over = {}) {
  return {
    userId: HARSH,
    title: 'buy milk',
    body: 'at Grocery',
    trigger: 'arrive',
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    deviceId: 'dev_n',
    noteIds: ['nte_1'],
    tags: [],
    priority: 0,
    ts: '2026-10-12T10:00:01Z',
    event: geo(),
    kind: 'note',
    ...over,
  };
}

test('a peer crossing is titled with the peer and rings the watch chime', () => {
  const item = fromGeo(geo(), HARSH);
  assert.equal(item.title, 'Nishtha arrived at Grocery');
  assert.equal(item.kind, 'watch');
  assert.equal(item.subjectUserId, NISHTHA);
  assert.equal(chimeFor(item), 'watch');
});

test('my own crossing says "You", and an old server without a subject is mine', () => {
  const mine = fromGeo(geo({ subjectUserId: HARSH, subjectName: 'Harsh', trigger: 'leave' }), HARSH);
  assert.equal(mine.title, 'You left Grocery');
  assert.equal(mine.kind, 'geo');
  assert.equal(chimeFor(mine), 'leave');

  const legacy = fromGeo(geo({ subjectUserId: undefined, subjectName: undefined, trigger: 'dwell' }));
  assert.equal(legacy.title, 'You are staying at Grocery');
  assert.equal(isPeerCrossing({ userId: HARSH }, undefined), false);
});

test('one crossing is one entry even when both frames arrive, in either order', () => {
  for (const order of [
    ['geo', 'notify'],
    ['notify', 'geo'],
  ]) {
    let items = [];
    const announced = [];
    for (const which of order) {
      const next = which === 'geo' ? fromGeo(geo(), HARSH) : fromReminder(reminder(), HARSH);
      const res = ingest(items, next);
      items = res.items;
      if (res.announce) announced.push(which);
    }
    assert.equal(items.length, 1, `order ${order}`);
    assert.equal(announced.length, 1, `order ${order}`);
    // The reminder's note text wins whichever frame came first.
    assert.equal(items[0].title, 'buy milk');
    assert.equal(items[0].body, 'at Grocery');
    assert.equal(items[0].subjectName, 'Nishtha');
  }
});

test('my own bare crossing is filed quietly, and its reminder is then announced', () => {
  const own = geo({ subjectUserId: HARSH, subjectName: 'Harsh' });
  const first = ingest([], fromGeo(own, HARSH));
  assert.equal(first.announce, false);
  assert.equal(unreadCount(first.items), 0);

  const second = ingest(first.items, fromReminder(reminder({ event: own }), HARSH));
  assert.equal(second.announce, true);
  assert.equal(second.items.length, 1);
  assert.equal(unreadCount(second.items), 1);
  assert.equal(second.item.title, 'buy milk');

  // A third frame for the same crossing (a reconnect replay) stays silent.
  assert.equal(ingest(second.items, fromReminder(reminder({ event: own }), HARSH)).announce, false);
});

test('a reminder from someone else keeps the sender', () => {
  const item = fromReminder(reminder({ userId: NISHTHA, fromUserId: HARSH, fromName: 'Harsh' }), NISHTHA);
  assert.equal(item.fromName, 'Harsh');
  assert.equal(item.kind, 'note');
  // Nishtha's own device crossed, so it is not a peer crossing for her.
  assert.equal(item.subjectUserId, undefined);
});

test('a re-described entry keeps its read state', () => {
  let { items } = ingest([], fromGeo(geo(), HARSH));
  items = markAllRead(items);
  assert.equal(unreadCount(items), 0);
  ({ items } = ingest(items, fromReminder(reminder(), HARSH)));
  assert.equal(unreadCount(items), 0);
});

test('entries are newest first and capped', () => {
  let items = [];
  for (let i = 0; i < MAX_ITEMS + 10; i += 1) {
    const ts = new Date(Date.UTC(2026, 9, 12, 0, 0, i)).toISOString();
    ({ items } = ingest(items, fromGeo(geo({ id: `evt_${i}`, ts }), HARSH)));
  }
  assert.equal(items.length, MAX_ITEMS);
  assert.equal(items[0].id, `evt_${MAX_ITEMS + 9}`);
  assert.ok(items.every((it, i) => i === 0 || items[i - 1].at >= it.at));
});

test('groupByDay splits at local midnight', () => {
  const now = new Date(2026, 9, 12, 15, 0, 0).getTime();
  const today = { ...fromGeo(geo({ id: 'a' }), HARSH), at: new Date(2026, 9, 12, 0, 5).getTime() };
  const yesterday = { ...fromGeo(geo({ id: 'b' }), HARSH), at: new Date(2026, 9, 11, 23, 55).getTime() };
  const groups = groupByDay([yesterday, today], now);
  assert.deepEqual(
    groups.today.map((i) => i.id),
    ['a'],
  );
  assert.deepEqual(
    groups.earlier.map((i) => i.id),
    ['b'],
  );
});

test('a reminder with no event still gets a stable id', () => {
  const a = fromReminder(reminder({ event: undefined }), HARSH);
  const b = fromReminder(reminder({ event: undefined }), HARSH);
  assert.equal(a.id, b.id);
  assert.equal(chimeFor(fromReminder(reminder({ kind: 'watch' }), HARSH)), 'watch');
  assert.equal(chimeFor(fromReminder(reminder({ trigger: 'passby' }), HARSH)), 'passby');
});

test('entries saved by an earlier page load come back read-as-they-were and never re-announce', () => {
  const saved = ingest([], fromGeo(geo({ subjectUserId: NISHTHA, subjectName: 'Nishtha' }), HARSH)).items;
  assert.equal(saved[0].announced, true);
  const restored = mergeStored([], JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.length, 1);
  assert.equal(unreadCount(restored), 1);
  // The same crossing replayed by the server after the reload is not news.
  const again = ingest(restored, fromGeo(geo({ subjectUserId: NISHTHA, subjectName: 'Nishtha' }), HARSH));
  assert.equal(again.announce, false);
  assert.equal(again.items.length, 1);
});

test('what the page already holds wins over what was stored, and junk is dropped', () => {
  const live = ingest([], fromGeo(geo({ subjectUserId: NISHTHA, subjectName: 'Nishtha' }), HARSH)).items;
  const stale = [{ ...live[0], title: 'old wording', announced: false }, { nonsense: true }, null];
  const merged = mergeStored(live, stale);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].title, live[0].title);
  assert.equal(mergeStored(live, []), live);
});
