import type { StoredReminder } from '../../api/reminders';
import type { GeoEvent, Point, Trigger } from '../../api/types';

/**
 * Reminders that wait for an acknowledgement (release spec §6), as plain data.
 *
 * A pending reminder is a sticky card that stays until someone presses
 * Acknowledge — here, in another tab, or on another device. The rules that make
 * that dependable all live in this file, free of React, the store and platform
 * APIs, so `node --test` can hold them still (reminders.test.mts):
 *
 *   - One card per reminder id, whichever way it arrived: the live `notify`
 *     frame, the pending list read on load and reconnect, or both, in any order.
 *   - An acknowledged id is remembered (a tombstone), so a frame or a list that
 *     was in flight when the ack happened cannot bring the card back.
 *   - Acknowledging is optimistic: the card goes at once, is parked, and comes
 *     back if the server refuses.
 *   - The chime repeats every `everyMs` while a card is pending. The schedule is
 *     per card, so two reminders that fired a minute apart do not ring together.
 *
 * Imports are type-only and relative, so Node can run it without a bundler.
 */

export type ReminderCard = {
  /** The reminder record id (one per recipient). */
  id: string;
  /** The crossing it came from: also the notification-centre entry's id. */
  eventId?: string;
  kind: 'note' | 'watch';
  trigger: Trigger;
  title: string;
  body?: string;
  placeId?: string;
  placeName?: string;
  deviceId?: string;
  /** Whose movement fired it, when that was someone other than the viewer. */
  subjectUserId?: string;
  subjectName?: string;
  /** The note's author when it is not the viewer ("from Harsh"). */
  fromName?: string;
  point?: Point;
  /** Epoch ms the reminder fired. */
  at: number;
  /** Epoch ms this session first learned of it. */
  receivedAt: number;
  /** Epoch ms of the last chime for this card; the next is due at lastChimeAt + everyMs. */
  lastChimeAt: number;
};

export type RemindersState = {
  /** Pending cards, newest first. */
  cards: ReminderCard[];
  /** Cards whose acknowledgement is on its way to the server, kept for a rollback. */
  inflight: Record<string, ReminderCard>;
  /** Acknowledged ids and when (epoch ms); a pending copy of one of these is ignored. */
  acked: Record<string, number>;
};

export const EMPTY_REMINDERS: RemindersState = { cards: [], inflight: {}, acked: {} };

/** DEFAULT_REMIND_EVERY_MS is how often a pending reminder chimes again. */
export const DEFAULT_REMIND_EVERY_MS = 60_000;
/** Never faster than this, whatever a test hook asks for: a chime needs room. */
export const MIN_REMIND_EVERY_MS = 1_000;
/** Tombstones kept; old ones only guard against replays that can no longer happen. */
export const MAX_TOMBSTONES = 300;

function stamp(iso: string | undefined, fallback: number): number {
  if (!iso) return fallback;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallback : ms;
}

function trimmed(value: string | undefined): string | undefined {
  const t = value?.trim();
  return t ? t : undefined;
}

/**
 * peerOf says whether the movement behind a reminder was somebody else's. The
 * record's own subject wins; an older record only has it on the event.
 */
function peerOf(r: StoredReminder, viewerId?: string): { id?: string; name?: string } {
  const e = eventOf(r);
  const id = r.subjectUserId || e?.subjectUserId;
  const name = r.subjectName || e?.subjectName;
  if (!id) return {};
  const self = viewerId ? id === viewerId : id === r.userId;
  return self ? {} : { id, name: trimmed(name) };
}

/** eventOf is the crossing a live notify frame carries; a stored row has none. */
function eventOf(r: StoredReminder): GeoEvent | undefined {
  return 'event' in r ? r.event : undefined;
}

/** cardFrom turns a stored reminder into a card. `kind:'ack'` notices are not cards. */
export function cardFrom(r: StoredReminder, viewerId?: string, now = Date.now()): ReminderCard | null {
  if (r.kind === 'ack') return null;
  const e = eventOf(r);
  const peer = peerOf(r, viewerId);
  const at = stamp(r.createdAt || ('ts' in r ? r.ts : undefined) || e?.ts, now);
  const title = trimmed(r.title) ?? 'Reminder';
  // A watch reminder repeats its title as the body for push channels, which
  // may show only one of them; on the card it would say it twice.
  const body = trimmed(r.body);
  return {
    id: r.id,
    eventId: r.eventId || e?.id || undefined,
    kind: r.kind === 'watch' ? 'watch' : 'note',
    trigger: r.trigger,
    title,
    body: body && body !== title ? body : undefined,
    placeId: r.placeId || e?.placeId || undefined,
    placeName: trimmed(r.placeName) ?? trimmed(e?.placeName),
    deviceId: ('deviceId' in r ? r.deviceId : undefined) || e?.deviceId || undefined,
    subjectUserId: peer.id,
    subjectName: peer.name,
    fromName: trimmed(r.fromName),
    point: e?.point,
    at,
    receivedAt: now,
    lastChimeAt: now,
  };
}

function sortCards(cards: ReminderCard[]): ReminderCard[] {
  return cards.slice().sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : 1));
}

function tombstone(acked: Record<string, number>, id: string, at: number): Record<string, number> {
  const next = { ...acked, [id]: at };
  const ids = Object.keys(next);
  if (ids.length <= MAX_TOMBSTONES) return next;
  // Drop the oldest beyond the cap.
  ids.sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0));
  for (const old of ids.slice(0, ids.length - MAX_TOMBSTONES)) delete next[old];
  return next;
}

/**
 * upsert files one record. Returns `added` when it made a new card — the one
 * case in which the caller rings the first chime. A pending record for a card
 * already shown only refreshes its wording and keeps its chime schedule; an
 * acknowledged record clears the card.
 */
export function upsert(
  state: RemindersState,
  r: StoredReminder,
  viewerId?: string,
  now = Date.now(),
): { state: RemindersState; added: boolean; card?: ReminderCard } {
  if (r.status === 'acknowledged') {
    return { state: acknowledge(state, r.id, stamp(r.ackedAt, now)), added: false };
  }
  if (state.acked[r.id] !== undefined || state.inflight[r.id]) return { state, added: false };
  const card = cardFrom(r, viewerId, now);
  if (!card) return { state, added: false };
  const index = state.cards.findIndex((c) => c.id === card.id);
  if (index >= 0) {
    const prev = state.cards[index]!;
    const merged: ReminderCard = {
      ...prev,
      ...card,
      at: prev.at,
      receivedAt: prev.receivedAt,
      lastChimeAt: prev.lastChimeAt,
    };
    const cards = state.cards.slice();
    cards[index] = merged;
    return { state: { ...state, cards }, added: false, card: merged };
  }
  return { state: { ...state, cards: sortCards([card, ...state.cards]) }, added: true, card };
}

/** acknowledge clears a card for good: a `reminder_ack` frame, or an acked record. */
export function acknowledge(state: RemindersState, id: string, ackedAt = Date.now()): RemindersState {
  const had = state.cards.some((c) => c.id === id) || !!state.inflight[id];
  if (!had && state.acked[id] !== undefined) return state;
  const inflight = { ...state.inflight };
  delete inflight[id];
  return {
    cards: state.cards.filter((c) => c.id !== id),
    inflight,
    acked: tombstone(state.acked, id, ackedAt),
  };
}

/**
 * beginAck is the optimistic half of pressing Acknowledge: the card leaves the
 * screen now and waits in `inflight` for the server's answer.
 */
export function beginAck(state: RemindersState, id: string): { state: RemindersState; card?: ReminderCard } {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return { state };
  return {
    state: { ...state, cards: state.cards.filter((c) => c.id !== id), inflight: { ...state.inflight, [id]: card } },
    card,
  };
}

/** commitAck is the server agreeing (or saying the reminder is already gone). */
export function commitAck(state: RemindersState, id: string, ackedAt = Date.now()): RemindersState {
  return acknowledge(state, id, ackedAt);
}

/**
 * rollbackAck is the server refusing: the card returns where it was. If an ack
 * frame from another session landed meanwhile, the reminder *is* acknowledged
 * and nothing comes back.
 */
export function rollbackAck(state: RemindersState, id: string): RemindersState {
  const card = state.inflight[id];
  if (!card) return state;
  const inflight = { ...state.inflight };
  delete inflight[id];
  if (state.acked[id] !== undefined) return { ...state, inflight };
  return { ...state, inflight, cards: sortCards([card, ...state.cards.filter((c) => c.id !== id)]) };
}

/**
 * reconcile applies the server's pending list (read on load, sign-in and every
 * reconnect). Every listed record is upserted; a card the list leaves out was
 * acknowledged somewhere while this session was not listening — but only if
 * the card is older than the request, since a reminder that arrived over the
 * socket after the list was read is legitimately missing from it.
 */
export function reconcile(
  state: RemindersState,
  records: StoredReminder[],
  requestedAt: number,
  viewerId?: string,
  now = Date.now(),
): { state: RemindersState; added: ReminderCard[]; removed: string[] } {
  let next = state;
  const added: ReminderCard[] = [];
  const listed = new Set<string>();
  for (const r of records) {
    listed.add(r.id);
    const res = upsert(next, r, viewerId, now);
    next = res.state;
    if (res.added && res.card) added.push(res.card);
  }
  const removed: string[] = [];
  for (const card of next.cards) {
    if (!listed.has(card.id) && card.receivedAt < requestedAt) removed.push(card.id);
  }
  for (const id of removed) next = acknowledge(next, id, now);
  return { state: next, added, removed };
}

/** dueCards are the cards whose next chime is due, oldest-due first. */
export function dueCards(state: RemindersState, now: number, everyMs: number): ReminderCard[] {
  const every = Math.max(MIN_REMIND_EVERY_MS, everyMs);
  return state.cards.filter((c) => now - c.lastChimeAt >= every).sort((a, b) => a.lastChimeAt - b.lastChimeAt);
}

/** markChimed restarts the interval for the given cards. */
export function markChimed(state: RemindersState, ids: string[], now: number): RemindersState {
  if (ids.length === 0) return state;
  const set = new Set(ids);
  return { ...state, cards: state.cards.map((c) => (set.has(c.id) ? { ...c, lastChimeAt: now } : c)) };
}

/** nextDueIn is how long until any card needs a chime, or null with nothing pending. */
export function nextDueIn(state: RemindersState, now: number, everyMs: number): number | null {
  if (state.cards.length === 0) return null;
  const every = Math.max(MIN_REMIND_EVERY_MS, everyMs);
  let soonest = Infinity;
  for (const c of state.cards) soonest = Math.min(soonest, c.lastChimeAt + every - now);
  return Math.max(0, soonest);
}

/**
 * resolveEveryMs picks the repeat interval: a test hook on window wins, then a
 * build-time variable, then the default. Anything unusable falls through.
 */
export function resolveEveryMs(hook: unknown, env: string | undefined): number {
  const fromHook = typeof hook === 'number' ? hook : typeof hook === 'string' ? Number(hook) : NaN;
  if (Number.isFinite(fromHook) && fromHook > 0) return Math.max(MIN_REMIND_EVERY_MS, fromHook);
  const fromEnv = env ? Number(env) : NaN;
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.max(MIN_REMIND_EVERY_MS, fromEnv);
  return DEFAULT_REMIND_EVERY_MS;
}

/** stackView is how the card stack renders: the newest card, and how many wait behind it. */
export function stackView(cards: ReminderCard[], expanded: boolean): { shown: ReminderCard[]; hidden: number } {
  if (expanded || cards.length <= 1) return { shown: cards, hidden: 0 };
  return { shown: cards.slice(0, 1), hidden: cards.length - 1 };
}
