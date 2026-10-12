import { useEffect } from 'react';
import { AppState, Platform } from 'react-native';

import { ApiError } from '@/api/client';
import { fetchReminders } from '@/api/reminders';
import { focusTarget, reminderTag } from '@/features/notify/announce';
import { showDesktop } from '@/features/notify/desktop';
import { chimeFor } from '@/features/notify/model';
import { repeatAction, resolveEveryMs, type ReminderCard } from '@/features/notify/reminders';
import { inQuietHours } from '@/features/notify/quiet';
import { playChime } from '@/features/notify/sound';
import { useStore } from '@/state/store';

/**
 * The two pieces of "a reminder keeps asking until it is acknowledged" that
 * touch the outside world (release spec §6): reading the pending list from the
 * server, and the repeat chime. The rules themselves are in
 * features/notify/reminders.ts.
 *
 * The repeat runs per tab. Two open Lura tabs each chime once per interval; they
 * are not coordinated, on purpose — a tab cannot know whether the other is
 * audible, and an acknowledgement in either clears both within a frame's
 * round trip, so the cost is at most one extra chime a minute while both are
 * open and visible. A hidden tab never chimes; it raises (and re-raises, under
 * the same tag, so it replaces rather than stacks) a desktop notification.
 */

let syncing: Promise<void> | null = null;
let again = false;

/**
 * syncPendingReminders reads GET /api/v1/reminders?status=pending into the
 * store. Called on sign-in / app load and on every socket (re)connect. A call
 * made while one is in flight runs once more after it, so the last answer is
 * never older than the last request for one.
 */
export function syncPendingReminders(): Promise<void> {
  if (syncing) {
    again = true;
    return syncing;
  }
  syncing = (async () => {
    do {
      again = false;
      const requestedAt = Date.now();
      try {
        const { reminders } = await fetchReminders('pending');
        useStore.getState().reconcileReminders(reminders ?? [], requestedAt);
      } catch (err) {
        // A server without §6 answers 404; offline is handled by the next
        // reconnect's sync. Neither is worth a toast.
        if (!(err instanceof ApiError)) break;
      }
    } while (again);
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

/** remindEveryMs reads the interval each time, so a test can change it on a live page. */
export function remindEveryMs(): number {
  const hook =
    Platform.OS === 'web' && typeof window !== 'undefined'
      ? (window as unknown as { __luraRemindEveryMs?: unknown }).__luraRemindEveryMs
      : undefined;
  return resolveEveryMs(hook, process.env.EXPO_PUBLIC_LURA_REMIND_EVERY_MS);
}

function visible(): boolean {
  if (Platform.OS === 'web') return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  return AppState.currentState === 'active';
}

/** TICK_MS is how often the schedule is checked; the interval itself is per card. */
const TICK_MS = 1_000;

function recordChime(card: ReminderCard, how: 'sound' | 'desktop' | 'muted' | 'quiet') {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  // Opt-in trace for end-to-end tests: set window.__luraChimeLog = [] first.
  const log = (window as unknown as { __luraChimeLog?: unknown }).__luraChimeLog;
  if (Array.isArray(log)) log.push({ id: card.id, how, at: Date.now() });
}

/**
 * useReminders mounts both halves once, in the signed-in shell: an initial read
 * of the pending list, and the repeat loop while anything is pending.
 */
export function useReminders(enabled = true) {
  const pending = useStore((s) => s.reminders.cards.length);

  useEffect(() => {
    if (enabled) void syncPendingReminders();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || pending === 0) return;
    const timer = setInterval(() => {
      const store = useStore.getState();
      const due = store.takeDueChimes(Date.now(), remindEveryMs());
      if (due.length === 0) return;
      // Quiet hours hold back the repeat as they hold back the first chime
      // (announce): the card stays on screen, silently, until acknowledged.
      const action = repeatAction({ quiet: inQuietHours(store.quietHours), visible: visible(), muted: store.muted });
      if (action !== 'desktop') {
        // One chime per tick even with several due: they would only overlap.
        const first = due[0]!;
        if (action === 'sound') {
          const chime = chimeFor(first);
          playChime(chime.kind, { watched: chime.watched });
        }
        recordChime(first, action);
        return;
      }
      for (const card of due) {
        const shown = showDesktop(
          { id: card.id, title: card.title, body: card.body, fromName: card.fromName, placeName: card.placeName },
          () =>
            useStore
              .getState()
              .requestFocus(
                focusTarget({
                  placeId: card.placeId,
                  subjectUserId: card.subjectUserId,
                  deviceId: card.deviceId,
                  point: card.point,
                }),
              ),
          { requireInteraction: true, renotify: true, silent: store.muted, tag: reminderTag(card.id) },
        );
        if (shown) recordChime(card, 'desktop');
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [enabled, pending]);
}
