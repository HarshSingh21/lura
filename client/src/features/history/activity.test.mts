import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActivityItem, ReminderRecord } from '../../api/types.ts';
import { buildTimeline, dayLabel, dayRange, describe, formatClock, inDay, tripTitle, validZone } from './activity.ts';

const IST = 'Asia/Kolkata';
const NY = 'America/New_York';
const HARSH = 'usr_harsh';
const NISHTHA = 'usr_nishtha';
const ctx = { tz: IST, viewerId: HARSH };

// 2026-10-12 15:00 IST.
const NOW = Date.UTC(2026, 9, 12, 9, 30);

/** An IST wall-clock time on 12 Oct 2026, as RFC 3339 UTC. */
function ist(hh: number, mm: number, day = 12): string {
  return new Date(Date.UTC(2026, 9, day, hh, mm) - 330 * 60_000).toISOString();
}

function reminder(over: Partial<ReminderRecord> = {}): ReminderRecord {
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
    body: '',
    subjectUserId: HARSH,
    subjectName: 'Harsh',
    eventId: 'geo_1',
    createdAt: ist(8, 51),
    status: 'acknowledged',
    ackedAt: ist(8, 52),
    ackedBy: HARSH,
    ...over,
  };
}

function geo(over: Partial<Extract<ActivityItem, { type: 'geo' }>> = {}): ActivityItem {
  return {
    type: 'geo',
    id: 'geo_1',
    ts: ist(8, 51),
    eventId: 'geo_1',
    triggerEventId: 'evt_1',
    placeId: 'plc_grocery',
    placeName: 'Grocery',
    trigger: 'passby',
    deviceId: 'dev_h',
    subjectUserId: HARSH,
    subjectName: 'Harsh',
    noteIds: ['nte_1'],
    delivered: ['inapp'],
    ...over,
  };
}

test('a day is midnight to midnight in the user zone, not the device zone', () => {
  const today = dayRange(0, IST, NOW);
  assert.equal(today.key, '2026-10-12');
  assert.equal(today.from, '2026-10-11T18:30:00.000Z');
  assert.equal(today.to, '2026-10-12T18:30:00.000Z');
  const yesterday = dayRange(1, IST, NOW);
  assert.equal(yesterday.key, '2026-10-11');
  assert.equal(yesterday.to, today.from);
  // Late evening UTC is already tomorrow in India.
  assert.equal(dayRange(0, IST, Date.UTC(2026, 9, 12, 20, 0)).key, '2026-10-13');
});

test('a day across a DST change is 23 or 25 hours long', () => {
  // US clocks go back on 1 Nov 2026 and forward on 8 Mar 2026.
  const back = dayRange(0, NY, Date.UTC(2026, 10, 1, 17, 0));
  assert.equal(back.key, '2026-11-01');
  assert.equal(back.from, '2026-11-01T04:00:00.000Z');
  assert.equal((back.endMs - back.startMs) / 3_600_000, 25);
  const forward = dayRange(0, NY, Date.UTC(2026, 2, 8, 17, 0));
  assert.equal((forward.endMs - forward.startMs) / 3_600_000, 23);
  // Month and year boundaries.
  assert.equal(dayRange(12, IST, NOW).key, '2026-09-30');
  assert.equal(dayRange(285, IST, NOW).key, '2025-12-31');
});

test('times and day labels read in the user zone', () => {
  assert.equal(formatClock(ist(8, 52), IST), '08:52');
  assert.equal(formatClock(ist(0, 5), IST), '00:05');
  assert.equal(formatClock('2026-10-12T03:22:00Z', NY), '23:22');
  assert.equal(formatClock(undefined, IST), '');
  assert.equal(formatClock('garbage', IST), '');
  assert.equal(dayLabel(0, IST, NOW), 'Today');
  assert.equal(dayLabel(1, IST, NOW), 'Yesterday');
  assert.equal(dayLabel(2, IST, NOW), 'Sat 10 Oct');
  assert.equal(dayLabel(300, IST, NOW), 'Tue 16 Dec 2025');
  assert.equal(validZone('Not/AZone'), validZone(undefined));
  assert.equal(validZone(IST), IST);
});

test('each kind of entry reads as a sentence', () => {
  assert.equal(describe(geo({ trigger: 'leave', placeName: 'Home' }), ctx).title, 'Left Home');
  assert.equal(describe(geo({ trigger: 'arrive', placeName: 'Office' }), ctx).title, 'Arrived at Office');
  const peer = describe(geo({ subjectUserId: NISHTHA, subjectName: 'Nishtha' }), ctx);
  assert.equal(peer.title, 'Nishtha passed Grocery');
  assert.equal(peer.personId, NISHTHA);
  assert.equal(peer.icon, 'passby');
  assert.equal(peer.time, '08:51');
  assert.deepEqual(peer.focus, { placeId: 'plc_grocery', placeName: 'Grocery' });

  const rem = describe({ type: 'reminder', id: 'r', ts: ist(8, 51), reminder: reminder({ eventId: '' }) }, ctx);
  assert.equal(rem.title, 'Reminder: buy milk — acknowledged 08:52');
  assert.equal(rem.status, 'acknowledged');
  const pending = describe(
    {
      type: 'reminder',
      id: 'r',
      ts: ist(8, 51),
      reminder: reminder({ status: 'pending', ackedAt: undefined, fromName: 'Harsh' }),
    },
    ctx,
  );
  assert.equal(pending.title, 'Reminder: buy milk — pending');
  assert.equal(pending.detail, 'Grocery · from Harsh');

  const ack = (byMe: boolean): ActivityItem => ({
    type: 'ack',
    id: 'a',
    ts: ist(8, 52),
    reminderId: 'rem_1',
    title: 'buy milk',
    body: '',
    placeName: 'Grocery',
    noteIds: [],
    ackedBy: byMe ? HARSH : NISHTHA,
    ackedByName: byMe ? 'Harsh' : 'Nishtha',
    byMe,
  });
  assert.equal(describe(ack(true), ctx).title, 'Acknowledged buy milk');
  assert.equal(describe(ack(false), ctx).title, 'Nishtha acknowledged buy milk');

  const trip = describe(
    {
      type: 'trip',
      id: 't',
      ts: ist(8, 42),
      deviceId: 'dev_h',
      deviceName: 'Pixel',
      mode: 'drive',
      startTs: ist(8, 42),
      endTs: ist(9, 5),
      distanceM: 7400,
      fromPlace: 'Home',
      toPlace: 'Office',
      path: [
        { lat: 1, lon: 1 },
        { lat: 2, lon: 2 },
      ],
    },
    ctx,
  );
  assert.equal(trip.title, 'Home → Office');
  // A trip between two spots that are not places says so once, not "Somewhere → somewhere".
  assert.equal(tripTitle('', ''), 'Trip');
  assert.equal(tripTitle(undefined, 'Office'), 'Trip to Office');
  assert.equal(tripTitle('Home', ' '), 'Trip from Home');
  assert.equal(trip.detail, 'drive · 23 min · 7.4 km');
  assert.equal(trip.focus?.path?.length, 2);

  const stop = describe(
    {
      type: 'stop',
      id: 's',
      ts: ist(9, 5),
      deviceId: 'dev_h',
      deviceName: 'Pixel',
      startTs: ist(9, 5),
      endTs: ist(12, 35),
      atPlace: 'Office',
      point: { lat: 3, lon: 3 },
    },
    { ...ctx, multipleDevices: true },
  );
  assert.equal(stop.title, 'Stopped at Office');
  assert.equal(stop.detail, '3h 30m · 09:05–12:35 · Pixel');

  const conn = (action: string, byMe: boolean): string =>
    describe(
      {
        type: 'connection',
        id: 'c',
        ts: ist(7, 0),
        action: action as 'paused',
        peerId: NISHTHA,
        peerName: 'Nishtha',
        byMe,
      },
      ctx,
    ).title;
  assert.equal(conn('paused', false), 'Nishtha paused sharing');
  assert.equal(conn('accepted', true), 'Connected with Nishtha');
  assert.equal(conn('invited', false), 'Nishtha invited you to connect');

  const share = describe(
    {
      type: 'share',
      id: 'sh',
      ts: ist(7, 0),
      action: 'revoked',
      shareId: 'shr',
      label: 'Ride home',
      mode: 'duration',
      reason: 'expired',
    },
    ctx,
  );
  assert.equal(share.title, 'Stopped sharing “Ride home”');
  assert.equal(share.detail, 'expired');
});

test('the timeline runs in the order the day happened, under part-of-day headings', () => {
  const items: ActivityItem[] = [
    geo({ id: 'g3', ts: ist(18, 30), eventId: 'evt_3', trigger: 'arrive', placeName: 'Home' }),
    geo({ id: 'g2', ts: ist(9, 5), eventId: 'evt_2', trigger: 'arrive', placeName: 'Office' }),
    {
      type: 'ack',
      id: 'a1',
      ts: ist(8, 52),
      reminderId: 'rem_1',
      title: 'buy milk',
      body: '',
      placeName: 'Grocery',
      noteIds: [],
      ackedBy: HARSH,
      ackedByName: 'Harsh',
      byMe: true,
    },
    { type: 'reminder', id: 'r1', ts: ist(8, 51), reminder: reminder() },
    geo({ id: 'g1', ts: ist(8, 51) }),
    geo({ id: 'g0', ts: ist(8, 42), eventId: 'evt_0', trigger: 'leave', placeName: 'Home' }),
    geo({ id: 'g0', ts: ist(8, 42), eventId: 'evt_0', trigger: 'leave', placeName: 'Home' }),
    geo({ id: 'gn', ts: ist(13, 0), eventId: 'evt_n', subjectUserId: NISHTHA, subjectName: 'Nishtha' }),
  ];
  const sections = buildTimeline(items, ctx);
  assert.deepEqual(
    sections.map((s) => s.title),
    ['MORNING', 'AFTERNOON', 'EVENING'],
  );
  const morning = sections[0]!.rows.map((r) => `${r.time} ${r.title}`);
  assert.deepEqual(morning, [
    '08:42 Left Home',
    '08:51 Passed Grocery — reminder buy milk',
    '08:52 Acknowledged buy milk',
    '09:05 Arrived at Office',
  ]);
  assert.equal(sections[0]!.rows[1]!.detail, 'acknowledged 08:52');
  assert.equal(sections[0]!.rows[1]!.status, 'acknowledged');
  assert.equal(sections[1]!.rows[0]!.title, 'Nishtha passed Grocery');
  assert.equal(sections[2]!.rows[0]!.title, 'Arrived at Home');
});

test('a reminder without its crossing in the feed stands on its own', () => {
  const sections = buildTimeline(
    [{ type: 'reminder', id: 'r1', ts: ist(4, 10), reminder: reminder({ status: 'pending', ackedAt: undefined }) }],
    ctx,
  );
  assert.equal(sections[0]!.title, 'EARLY HOURS');
  assert.equal(sections[0]!.rows[0]!.title, 'Reminder: buy milk — pending');
  assert.deepEqual(buildTimeline([], ctx), []);
});

test('inDay drops what the server returned on the boundary of the next day', () => {
  const range = dayRange(0, IST, NOW);
  const items = [geo({ id: 'in', ts: ist(0, 0) }), geo({ id: 'out', ts: ist(0, 0, 13) })];
  assert.deepEqual(
    inDay(items, range).map((i) => i.id),
    ['in'],
  );
});

test('a reminder joins its crossing by id, even beside a twin at the same fence and moment', () => {
  // Two people pass Grocery in the same second; the reminder came from the
  // second crossing, and the shared eventId (the GeoEvent id) says so.
  const items: ActivityItem[] = [
    geo({ id: 'geo:evt_a', eventId: 'geo_a', triggerEventId: 'evt_a', deviceId: 'dev_h' }),
    geo({ id: 'geo:evt_b', eventId: 'geo_b', triggerEventId: 'evt_b', deviceId: 'dev_x' }),
    { type: 'reminder', id: 'r', ts: ist(8, 51), reminder: reminder({ eventId: 'geo_b', title: 'buy milk' }) },
  ];
  const rows = buildTimeline(items, ctx).flatMap((s) => s.rows);
  assert.equal(rows.length, 2);
  assert.match(rows.find((r) => r.id === 'geo:evt_b')!.title, /reminder buy milk/);
  assert.doesNotMatch(rows.find((r) => r.id === 'geo:evt_a')!.title, /reminder/);
});

test('the note text names a reminder, and a crossing named by another id still folds', () => {
  // As the server sends it: the title is the crossing, the body the note. A
  // crossing recorded before 0.2.0 carries its trigger-log id, not the geo
  // event id the reminder has, so it folds by fence, trigger and moment.
  const items: ActivityItem[] = [
    geo({ id: 'g', ts: ist(12, 4), eventId: 'evt_log_1', trigger: 'arrive', placeName: 'Whole Foods' }),
    {
      type: 'reminder',
      id: 'r',
      ts: ist(12, 4),
      reminder: reminder({
        eventId: 'geo_live_1',
        trigger: 'arrive',
        title: 'Arrived at Whole Foods',
        body: 'buy milk',
        createdAt: ist(12, 4),
        ackedAt: ist(12, 6),
      }),
    },
    {
      type: 'ack',
      id: 'a',
      ts: ist(12, 6),
      reminderId: 'rem_1',
      title: 'Arrived at Whole Foods',
      body: 'buy milk',
      placeName: 'Whole Foods',
      noteIds: ['nte_1'],
      ackedBy: NISHTHA,
      ackedByName: 'Nishtha',
      byMe: false,
    },
    // A different fence at the same moment does not fold.
    geo({ id: 'g2', ts: ist(12, 4), eventId: 'evt_log_2', placeId: 'plc_gym', placeName: 'Gym', trigger: 'arrive' }),
  ];
  const rows = buildTimeline(items, ctx).flatMap((s) => s.rows.map((r) => r.title));
  assert.deepEqual(rows, [
    'Arrived at Whole Foods — reminder buy milk',
    'Arrived at Gym',
    'Nishtha acknowledged buy milk',
  ]);
});
