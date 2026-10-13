import type { GeoEvent, Point, Reminder, ReminderRecord, ReminderStatus, Trigger } from '../../api/types';

/**
 * The notification centre's data model, free of React, of the store and of any
 * platform API.
 *
 * Two live frames can describe the same crossing: the geofence engine publishes a
 * `geo` frame to the place owner, and when a note (or a watch) fired, the notify
 * fan-out sends a `notify` frame whose `event` is that same GeoEvent. The rule the
 * product promises is "one crossing = one toast + one sound", so everything here
 * is keyed by the event id, and a second frame for the same crossing *enriches*
 * the entry it already made instead of adding another.
 *
 * The file only imports types, with relative paths, so `node --test` can run its
 * tests without a bundler (see model.test.mjs).
 */

/**
 * ChimeKind picks the sound: one per trigger, so arrive, leave and pass-by can be
 * told apart by ear (release spec §4). A watched person's crossing rings the same
 * trigger's chime with the watch bell layered on top (see `Chime.watched`).
 */
export type ChimeKind = 'arrive' | 'leave' | 'passby' | 'dwell';

/** Chime is what one announcement sounds like. */
export type Chime = { kind: ChimeKind; watched: boolean };

/** Mirrors api/reminders.isStored; repeated so this file keeps type-only imports. */
function isStored(r: Reminder | ReminderRecord): boolean {
  return typeof r.id === 'string' && r.id !== '' && (r.status === 'pending' || r.status === 'acknowledged');
}

export type NotificationItem = {
  /** The crossing's id — the GeoEvent id — so both frames for it land on one entry. */
  id: string;
  /**
   * 'geo' = a fence crossing with no note; 'note' = a note fired; 'watch' = a
   * watched person crossed; 'ack' = someone acknowledged a note of mine.
   */
  kind: 'geo' | 'note' | 'watch' | 'ack';
  /** Which frame described it last-best: a reminder carries more than a bare crossing. */
  source: 'geo' | 'notify';
  trigger: Trigger;
  title: string;
  body?: string;
  placeId?: string;
  placeName?: string;
  /** Whose device crossed. Empty when it was the viewer's own. */
  subjectUserId?: string;
  subjectName?: string;
  deviceId?: string;
  /** Who wrote the note, when it was not the viewer ("from Harsh"). */
  fromName?: string;
  /** Where the crossing happened, for "show me" when the place is not one of mine. */
  point?: Point;
  /** Epoch ms of the crossing (server time), used for ordering and grouping. */
  at: number;
  read: boolean;
  /** The stored reminder behind this entry (release spec §6), when there is one. */
  reminderId?: string;
  /** Whether that reminder still waits for an Acknowledge. Absent for a bare crossing. */
  status?: ReminderStatus;
  /** Epoch ms it was acknowledged. */
  ackedAt?: number;
  /** Whether this crossing has had its toast and sound. A crossing gets them once. */
  announced: boolean;
};

/** The notification centre keeps the session's recent history, not an archive. */
export const MAX_ITEMS = 100;

const VERB: Record<Trigger, string> = {
  arrive: 'arrived at',
  leave: 'left',
  passby: 'passed by',
  dwell: 'is staying at',
};

/** selfVerb fixes the grammar of "You is staying at". */
function verbFor(trigger: Trigger, self: boolean): string {
  if (self && trigger === 'dwell') return 'are staying at';
  return VERB[trigger] ?? 'crossed';
}

function stamp(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallback : ms;
}

/**
 * isPeerCrossing says whether a geo event is about someone other than the viewer.
 *
 * `userId` is the place owner and `subjectUserId` whose device crossed; an older
 * server sends no subject at all, which can only mean the owner's own device.
 */
export function isPeerCrossing(e: Pick<GeoEvent, 'userId' | 'subjectUserId'>, viewerId?: string): boolean {
  const subject = e.subjectUserId;
  if (!subject) return false;
  if (viewerId) return subject !== viewerId;
  return subject !== e.userId;
}

/** fromGeo turns a fence crossing into an entry: "Nishtha arrived at Grocery". */
export function fromGeo(e: GeoEvent, viewerId?: string, now = Date.now()): NotificationItem {
  const peer = isPeerCrossing(e, viewerId);
  const who = peer ? e.subjectName?.trim() || 'Someone' : 'You';
  const place = e.placeName?.trim() || 'a place';
  return {
    id: e.id || `geo:${e.placeId}:${e.trigger}:${e.ts}`,
    kind: peer ? 'watch' : 'geo',
    source: 'geo',
    trigger: e.trigger,
    title: `${who} ${verbFor(e.trigger, !peer)} ${place}`,
    placeId: e.placeId || undefined,
    placeName: e.placeName || undefined,
    subjectUserId: peer ? e.subjectUserId : undefined,
    subjectName: peer ? e.subjectName || undefined : undefined,
    deviceId: e.deviceId || undefined,
    point: e.point,
    at: stamp(e.ts, now),
    read: false,
    announced: false,
  };
}

/** fromReminder turns a delivered reminder into an entry, keeping the note text. */
export function fromReminder(r: Reminder | ReminderRecord, viewerId?: string, now = Date.now()): NotificationItem {
  // A live frame carries the crossing; a stored row (GET /reminders) only its id
  // and subject.
  const e = 'event' in r ? r.event : undefined;
  const ts = ('ts' in r ? r.ts : undefined) || r.createdAt || e?.ts;
  const subject =
    e && e.subjectUserId
      ? { userId: e.userId, subjectUserId: e.subjectUserId, name: e.subjectName }
      : { userId: r.userId, subjectUserId: r.subjectUserId ?? '', name: r.subjectName };
  const peer = isPeerCrossing(subject, viewerId);
  const stored = isStored(r) && !!r.id;
  const ack = r.kind === 'ack';
  // An acknowledgement is news of its own, not another description of the
  // crossing, so it must not fold into that crossing's entry.
  const id = ack
    ? `ack:${stored ? r.id : `${r.placeId}:${ts}`}`
    : e?.id || r.eventId || `notify:${r.placeId}:${r.trigger}:${ts}`;
  const status: Pick<NotificationItem, 'reminderId' | 'status' | 'ackedAt'> =
    stored && !ack && r.id && r.status
      ? { reminderId: r.id, status: r.status, ackedAt: r.ackedAt ? stamp(r.ackedAt, now) : undefined }
      : {};
  const title = r.title?.trim() || (e ? fromGeo(e, viewerId, now).title : 'Reminder');
  // A watch reminder repeats its title as the body, which push channels need (a
  // phone banner may show only one of them); on screen it would say it twice.
  // So does an acknowledgement: "Nishtha acknowledged buy milk" already names
  // the note its body carries.
  const body = ack ? undefined : r.body?.trim();
  return {
    id,
    ...status,
    kind: ack ? 'ack' : r.kind === 'watch' ? 'watch' : 'note',
    source: 'notify',
    trigger: r.trigger,
    title,
    body: body && body !== title ? body : undefined,
    placeId: r.placeId || e?.placeId || undefined,
    placeName: r.placeName || e?.placeName || undefined,
    subjectUserId: peer ? subject.subjectUserId : undefined,
    subjectName: peer ? subject.name || undefined : undefined,
    deviceId: ('deviceId' in r ? r.deviceId : undefined) || e?.deviceId || undefined,
    fromName: r.fromName?.trim() || undefined,
    point: e?.point,
    at: stamp(ts, now),
    read: false,
    announced: false,
  };
}

/**
 * mergeItem folds two descriptions of one crossing together.
 *
 * The reminder is the richer of the two — it carries the note text and the
 * sender — so its title and body win; the geo frame's subject and point fill any
 * gap. Read state is preserved: re-describing an entry is not news.
 */
export function mergeItem(prev: NotificationItem, next: NotificationItem): NotificationItem {
  const richer = next.source === 'notify' || prev.source === 'geo' ? next : prev;
  const other = richer === next ? prev : next;
  return {
    ...other,
    ...stripUndefined(richer),
    subjectUserId: richer.subjectUserId ?? other.subjectUserId,
    subjectName: richer.subjectName ?? other.subjectName,
    point: richer.point ?? other.point,
    body: richer.body ?? other.body,
    fromName: richer.fromName ?? other.fromName,
    read: prev.read,
    at: Math.min(prev.at, next.at),
    ...mergeStatus(prev, next),
  };
}

/** Acknowledged is final: a replayed pending copy cannot reopen an entry. */
function mergeStatus(
  prev: NotificationItem,
  next: NotificationItem,
): Pick<NotificationItem, 'reminderId' | 'status' | 'ackedAt'> {
  const reminderId = next.reminderId ?? prev.reminderId;
  if (prev.status === 'acknowledged' || next.status === 'acknowledged') {
    return { reminderId, status: 'acknowledged', ackedAt: prev.ackedAt ?? next.ackedAt };
  }
  return { reminderId, status: next.status ?? prev.status, ackedAt: undefined };
}

/**
 * setReminderStatus marks the entry for a reminder as pending or acknowledged
 * (an Acknowledge here, a `reminder_ack` from elsewhere, or a rollback).
 */
export function setReminderStatus(
  items: NotificationItem[],
  reminderId: string,
  status: ReminderStatus,
  ackedAt?: number,
): NotificationItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.reminderId !== reminderId) return item;
    changed = true;
    return { ...item, status, ackedAt: status === 'acknowledged' ? (ackedAt ?? item.ackedAt) : undefined };
  });
  return changed ? next : items;
}

/** filterItems is the panel's All / Pending switch. */
export function filterItems(items: NotificationItem[], filter: 'all' | 'pending'): NotificationItem[] {
  return filter === 'pending' ? items.filter((i) => i.status === 'pending') : items;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * deservesAnnouncement is the spec's rule for what toasts and chimes: every
 * reminder, and every crossing by somebody else. My own bare crossing — no note
 * attached — is recorded quietly: I know I walked into the shop.
 */
export function deservesAnnouncement(item: Pick<NotificationItem, 'source' | 'kind'>): boolean {
  return item.source === 'notify' || item.kind === 'watch';
}

/**
 * ingest adds or updates an entry, newest first, and says whether to announce it.
 *
 * `announce` is true at most once per crossing: the first frame that deserves a
 * toast and a sound gets them, and a later frame for the same crossing only
 * re-words the entry. A quiet entry (my own bare crossing) is filed as read; if
 * the reminder for it arrives next, that one is announced and becomes unread.
 */
export function ingest(
  items: NotificationItem[],
  next: NotificationItem,
): { items: NotificationItem[]; announce: boolean; item: NotificationItem } {
  // By crossing, or by stored reminder: a row read from the server and a live
  // frame are the same reminder even if they name its crossing differently.
  const index = items.findIndex(
    (i) => i.id === next.id || (next.reminderId !== undefined && i.reminderId === next.reminderId),
  );
  const prev = index >= 0 ? items[index] : undefined;
  const base = prev ? mergeItem(prev, next) : next;
  const announce = !base.announced && !prev?.announced && deservesAnnouncement(base);
  const item: NotificationItem = {
    ...base,
    announced: announce || !!prev?.announced,
    read: announce ? false : prev ? prev.read : !deservesAnnouncement(base),
  };
  if (prev) {
    const copy = items.slice();
    copy[index] = item;
    return { items: copy, announce, item };
  }
  const added = [item, ...items].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
  return { items: added, announce, item };
}

/**
 * mergeStored folds the entries saved by an earlier page load (or another tab)
 * into the live list. What this page already holds wins — it is newer — and a
 * stored entry is always treated as announced, so it never toasts or chimes
 * again. Malformed rows are dropped.
 */
export function mergeStored(live: NotificationItem[], stored: NotificationItem[]): NotificationItem[] {
  const have = new Set(live.map((i) => i.id));
  const extra = stored
    .filter((i) => i && typeof i.id === 'string' && typeof i.title === 'string' && Number.isFinite(i.at) && !have.has(i.id))
    .map((i) => ({ ...i, announced: true }));
  if (extra.length === 0) return live;
  return [...live, ...extra].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
}

export function unreadCount(items: NotificationItem[]): number {
  let n = 0;
  for (const item of items) if (!item.read) n += 1;
  return n;
}

export function markAllRead(items: NotificationItem[]): NotificationItem[] {
  return items.some((i) => !i.read) ? items.map((i) => (i.read ? i : { ...i, read: true })) : items;
}

/** groupByDay splits the list for the panel: today (local time) and earlier, both newest first. */
export function groupByDay(
  items: NotificationItem[],
  now = Date.now(),
): { today: NotificationItem[]; earlier: NotificationItem[] } {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const cut = midnight.getTime();
  const sorted = items.slice().sort((a, b) => b.at - a.at);
  return { today: sorted.filter((i) => i.at >= cut), earlier: sorted.filter((i) => i.at < cut) };
}

/**
 * chimeFor maps an entry to its sound: the trigger's chime, with the watch bell
 * on top when it is about someone the viewer watches — "Nishtha arrived" and
 * "Nishtha left" must not sound the same. An acknowledgement ("Nishtha
 * acknowledged buy milk") rings the soft double knock, a closing sound.
 */
export function chimeFor(item: Pick<NotificationItem, 'kind' | 'trigger'>): Chime {
  if (item.kind === 'ack') return { kind: 'dwell', watched: false };
  const kind: ChimeKind =
    item.trigger === 'leave' || item.trigger === 'passby' || item.trigger === 'dwell' ? item.trigger : 'arrive';
  return { kind, watched: item.kind === 'watch' };
}
