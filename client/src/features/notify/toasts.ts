import type { NotificationItem } from './model';

/**
 * What the toast stack does when a crossing or reminder is filed (the store's
 * notify, after model.ts `ingest` has deduped it into one entry).
 *
 * One crossing can arrive as two frames (geo, then notify), again in a replay
 * after a reconnect, and once more from the pending list read on every
 * (re)connect. The rules that keep that to one entry, one toast and one chime:
 *
 *   - a pending reminder is a sticky card (ReminderCards), never a toast; a
 *     toast its crossing already raised gives way to it;
 *   - a later frame for an entry already announced re-words its toast (the
 *     reminder carries the note text) instead of stacking another;
 *   - only a first announcement adds a toast, and the stack keeps four.
 *
 * Imports nothing at runtime, so it is tested with plain `node --test`.
 */

export type NotifyToast = {
  id: string;
  title: string;
  body?: string;
  kind: 'reminder' | 'event' | 'error' | 'info';
  at: number;
  /** For reminder/event toasts: the notification-centre entry this toast announces. */
  notificationId?: string;
};

/** The stack keeps this many toasts; the oldest goes first. */
export const MAX_TOASTS = 4;

export function toastsAfter<T extends NotifyToast>(
  toasts: T[],
  res: { item: NotificationItem; announce: boolean },
  nextToast: () => { id: string; at: number },
): T[] {
  const { item } = res;
  if (item.status === 'pending') return toasts.filter((t) => t.notificationId !== item.id);
  if (!res.announce) {
    return toasts.map((t) => (t.notificationId === item.id ? { ...t, title: item.title, body: item.body } : t));
  }
  const toast = {
    ...nextToast(),
    title: item.title,
    body: item.body,
    kind: item.kind === 'geo' ? ('event' as const) : ('reminder' as const),
    notificationId: item.id,
  } as T;
  return [...toasts.slice(-(MAX_TOASTS - 1)), toast];
}
