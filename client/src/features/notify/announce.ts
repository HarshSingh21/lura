import type { Point } from '@/api/types';

import { showDesktop } from './desktop';
import { announcement, reminderTag, type NotificationItem } from './model';
import { playChime } from './sound';

/**
 * announce is the side-effect half of a new notification: the chime (unless the
 * viewer muted it) and, when the tab is hidden, a system notification. The store
 * calls it exactly once per crossing — the dedupe has already happened by then.
 *
 * During the viewer's quiet hours neither happens: the toast and the panel
 * entry are the whole announcement, as the server holds back push (quiet.ts).
 */
export function announce(item: NotificationItem, opts: { muted: boolean; quiet?: boolean; onOpen?: () => void }): void {
  const { chime, desktop } = announcement(item, opts);
  if (chime) playChime(chime.kind, { watched: chime.watched });
  if (desktop) showDesktop(item, opts.onOpen, desktop);
}

export { reminderTag };

/**
 * focusTarget is what "show me" means for an entry: the person, when it is about
 * someone (their marker follows them), otherwise the place.
 */
export function focusTarget(
  item: Pick<NotificationItem, 'placeId' | 'subjectUserId' | 'deviceId' | 'point'>,
): { placeId?: string; deviceId?: string; point?: Point } {
  return {
    placeId: item.placeId,
    deviceId: item.subjectUserId ? item.deviceId : undefined,
    point: item.point,
  };
}
