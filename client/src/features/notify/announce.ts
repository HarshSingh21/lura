import type { Point } from '@/api/types';

import { showDesktop } from './desktop';
import { chimeFor, type NotificationItem } from './model';
import { playChime } from './sound';

/**
 * announce is the side-effect half of a new notification: the chime (unless the
 * viewer muted it) and, when the tab is hidden, a system notification. The store
 * calls it exactly once per crossing — the dedupe has already happened by then.
 */
export function announce(item: NotificationItem, opts: { muted: boolean; onOpen?: () => void }): void {
  if (!opts.muted) playChime(chimeFor(item));
  showDesktop(item, opts.onOpen);
}

/**
 * focusTarget is what "show me" means for an entry: the person, when it is about
 * someone (their marker follows them), otherwise the place.
 */
export function focusTarget(item: NotificationItem): { placeId?: string; deviceId?: string; point?: Point } {
  return {
    placeId: item.placeId,
    deviceId: item.subjectUserId ? item.deviceId : undefined,
    point: item.point,
  };
}
