// One crossing, many arrivals: the geo frame, the notify frame, the replay
// after a reconnect (since=), and the pending list read on every (re)connect.
// The page must show one notification-centre entry, ring once, and show the
// reminder as one sticky card — never also as a toast, never counted twice.
//
// fakePage mirrors state/store.ts's notify / reconcileReminders /
// applyReminderAck using the same model functions.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GeoEvent, Reminder, ReminderRecord } from '../../api/types.ts';
import { fromGeo, fromReminder, ingest, setReminderStatus, unreadCount, type NotificationItem } from './model.ts';
import { acknowledge, EMPTY_REMINDERS, reconcile, upsert, type RemindersState } from './reminders.ts';
import { MAX_TOASTS, toastsAfter, type NotifyToast } from './toasts.ts';

const HARSH = 'usr_harsh';
const NISHTHA = 'usr_nishtha';
const T0 = Date.UTC(2026, 9, 12, 8, 51, 0);

const crossing: GeoEvent = {
  id: 'evt_grocery',
  userId: HARSH,
  deviceId: 'dev_nishtha',
  placeId: 'plc_grocery',
  placeName: 'Grocery',
  trigger: 'arrive',
  ts: '2026-10-12T08:51:00Z',
  point: { lat: 12.9, lon: 77.6 },
  speedMps: 0.5,
  subjectUserId: NISHTHA,
  subjectName: 'Nishtha',
};

function notifyFrame(over: Partial<Reminder> = {}) {
  return {
    id: 'rem_milk',
    status: 'pending',
    userId: HARSH,
    ownerId: HARSH,
    eventId: crossing.id,
    createdAt: crossing.ts,
    title: 'Nishtha arrived at Grocery',
    body: 'buy milk',
    trigger: 'arrive',
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    deviceId: 'dev_nishtha',
    noteIds: ['nte_milk'],
    tags: [],
    priority: 0,
    ts: crossing.ts,
    kind: 'note',
    subjectUserId: NISHTHA,
    subjectName: 'Nishtha',
    event: crossing,
    ...over,
  } as Reminder & { id: string; status: 'pending' | 'acknowledged' };
}

function pendingRow(over: Partial<ReminderRecord> = {}): ReminderRecord {
  return {
    id: 'rem_milk',
    userId: HARSH,
    ownerId: HARSH,
    noteIds: ['nte_milk'],
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    trigger: 'arrive',
    kind: 'note',
    title: 'Nishtha arrived at Grocery',
    body: 'buy milk',
    subjectUserId: NISHTHA,
    subjectName: 'Nishtha',
    eventId: crossing.id,
    createdAt: crossing.ts,
    status: 'pending',
    ...over,
  };
}

function fakePage(viewerId = HARSH) {
  let seq = 0;
  const page = {
    notifications: [] as NotificationItem[],
    toasts: [] as NotifyToast[],
    reminders: EMPTY_REMINDERS as RemindersState,
    announced: 0,
    notify(next: NotificationItem) {
      const res = ingest(page.notifications, next);
      page.notifications = res.items;
      page.toasts = toastsAfter(page.toasts, res, () => ({ id: `toast_${++seq}`, at: T0 + seq }));
      if (res.announce) page.announced++;
    },
    geo(e: GeoEvent) {
      page.notify(fromGeo(e, viewerId, T0));
    },
    reminder(r: Reminder & { id: string; status: string }) {
      page.reminders = upsert(page.reminders, r as never, viewerId, T0).state;
      page.notify(fromReminder(r, viewerId, T0));
    },
    pendingList(rows: ReminderRecord[], requestedAt = T0 + 5_000) {
      const res = reconcile(page.reminders, rows, requestedAt, viewerId, requestedAt + 100);
      for (const id of res.removed) page.notifications = setReminderStatus(page.notifications, id, 'acknowledged');
      page.reminders = res.state;
      const live = new Set(res.state.cards.map((c) => c.id));
      for (const r of rows) if (live.has(r.id)) page.notify(fromReminder(r, viewerId, T0));
    },
    ackElsewhere(id: string, at = T0 + 60_000) {
      page.reminders = acknowledge(page.reminders, id, at);
      page.notifications = setReminderStatus(page.notifications, id, 'acknowledged', at);
    },
  };
  return page;
}

test('geo then notify for one crossing: one entry, one chime, one card, no toast left', () => {
  const page = fakePage();
  page.geo(crossing);
  assert.equal(page.toasts.length, 1, 'the bare crossing toasts while the reminder is on its way');
  page.reminder(notifyFrame());

  assert.equal(page.notifications.length, 1);
  assert.equal(unreadCount(page.notifications), 1);
  assert.equal(page.announced, 1, 'rang once');
  assert.equal(page.reminders.cards.length, 1);
  assert.equal(page.toasts.length, 0, 'the sticky card replaced the toast');
});

test('notify before geo (frames out of order) is still one entry and one card', () => {
  const page = fakePage();
  page.reminder(notifyFrame());
  page.geo(crossing);
  assert.equal(page.notifications.length, 1);
  assert.equal(unreadCount(page.notifications), 1);
  assert.equal(page.announced, 1);
  assert.equal(page.reminders.cards.length, 1);
  assert.equal(page.toasts.length, 0);
});

test('a reconnect replays both frames and re-reads the pending list: nothing doubles', () => {
  const page = fakePage();
  page.geo(crossing);
  page.reminder(notifyFrame());
  // The socket drops; on reconnect the hub replays since= and the hello re-reads the list.
  page.geo(crossing);
  page.reminder(notifyFrame());
  page.pendingList([pendingRow()]);
  page.pendingList([pendingRow()], T0 + 10_000);

  assert.equal(page.notifications.length, 1);
  assert.equal(unreadCount(page.notifications), 1);
  assert.equal(page.announced, 1);
  assert.equal(page.reminders.cards.length, 1);
  assert.equal(page.toasts.length, 0);
});

test('a reminder first seen in the pending list (fired while offline) is a card that rings once', () => {
  const page = fakePage();
  page.pendingList([pendingRow()]);
  page.reminder(notifyFrame()); // and then the replay delivers it too
  assert.equal(page.reminders.cards.length, 1);
  assert.equal(page.notifications.length, 1);
  assert.equal(page.announced, 1);
  assert.equal(page.toasts.length, 0);
});

test('an ack in another tab clears the card; replays and the list cannot bring it back or re-ring', () => {
  const page = fakePage();
  page.geo(crossing);
  page.reminder(notifyFrame());
  page.ackElsewhere('rem_milk');
  assert.equal(page.reminders.cards.length, 0);
  assert.equal(page.notifications[0]!.status, 'acknowledged');

  page.reminder(notifyFrame()); // a replay that was already in flight
  page.pendingList([pendingRow()], T0 + 30_000); // a list requested before the ack
  page.pendingList([], T0 + 70_000);
  assert.equal(page.reminders.cards.length, 0);
  assert.equal(page.notifications.length, 1);
  assert.equal(page.notifications[0]!.status, 'acknowledged', 'a stale pending frame does not re-open the entry');
  assert.equal(page.announced, 1);
  assert.equal(page.toasts.length, 0);
});

test('a crossing with no note toasts once, however often it is replayed', () => {
  const page = fakePage();
  const bare: GeoEvent = { ...crossing, id: 'evt_bare', subjectUserId: NISHTHA };
  page.geo(bare);
  page.geo(bare);
  page.geo(bare);
  assert.equal(page.toasts.length, 1);
  assert.equal(page.notifications.length, 1);
  assert.equal(page.reminders.cards.length, 0);
});

test('Nishtha acknowledging my note is a toast for me, not a card, and only once', () => {
  const page = fakePage();
  const ack = notifyFrame({
    id: 'rem_ack',
    kind: 'ack',
    status: 'acknowledged',
    eventId: 'ack_1',
    title: 'Nishtha acknowledged buy milk',
    event: undefined,
  } as never);
  page.reminder(ack);
  page.reminder(ack);
  assert.equal(page.reminders.cards.length, 0);
  assert.equal(page.toasts.length, 1);
  assert.equal(page.toasts[0]!.kind, 'reminder');
  assert.equal(page.notifications.length, 1);
});

test('the toast stack keeps the newest four', () => {
  const page = fakePage();
  for (let i = 0; i < 7; i++) page.geo({ ...crossing, id: `evt_${i}`, ts: new Date(T0 + i * 1000).toISOString() });
  assert.equal(page.toasts.length, MAX_TOASTS);
  assert.deepEqual(
    page.toasts.map((t) => t.notificationId),
    ['evt_3', 'evt_4', 'evt_5', 'evt_6'],
  );
});
