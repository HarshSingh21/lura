import { useCallback, useSyncExternalStore } from 'react';
import { StyleSheet, View } from 'react-native';

import { useOverview } from '@/api/hooks';
import { Icon, type IconName } from '@/components/ui/Icon';
import { personColor } from '@/features/people/color';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, size, withAlpha } from '@/theme/tokens';
import { useStore } from '@/state/store';

import { focusTarget } from './announce';
import { desktopPermission, requestDesktop, type DesktopPermission } from './desktop';
import type { NotificationItem } from './model';

/**
 * Presentation shared by the toast and the notification panel, so an entry looks
 * the same in both places: the same glyph per trigger, the same colour per
 * person, the same "from Harsh" line.
 */

const GLYPH: Record<string, IconName> = {
  arrive: 'arrive',
  leave: 'leave',
  passby: 'passby',
  dwell: 'dwell',
};

/** tintFor colours an entry by who it is about: a person's own colour, else the brand. */
export function tintFor(item: Pick<NotificationItem, 'subjectUserId' | 'trigger'>): string {
  if (item.subjectUserId) return personColor(item.subjectUserId);
  return item.trigger === 'passby' ? palette.amberDark : palette.accent;
}

/** NotificationGlyph is the trigger icon in a tinted tile, with a "watch" eye for a watched person. */
export function NotificationGlyph({
  item,
  size: s = 34,
}: {
  item: Pick<NotificationItem, 'kind' | 'trigger' | 'subjectUserId'>;
  size?: number;
}) {
  const tint = tintFor(item);
  const glyph: IconName = item.kind === 'ack' ? 'check' : (GLYPH[item.trigger] ?? 'live');
  return (
    <View style={[styles.glyph, { width: s, height: s, borderRadius: s * 0.32, backgroundColor: withAlpha(tint, 0.14) }]}>
      <Icon name={glyph} size={s * 0.56} color={tint} strokeWidth={1.8} />
      {item.kind === 'watch' ? (
        <View style={[styles.badge, { backgroundColor: tint }]}>
          <Icon name="watch" size={10} color="#ffffff" strokeWidth={2} />
        </View>
      ) : null}
    </View>
  );
}

/** NotificationMeta is the small line under a title: person · place · from · time. */
export function NotificationMeta({ item, now }: { item: NotificationItem; now?: number }) {
  return (
    <View style={styles.meta}>
      {item.subjectName ? (
        <View style={styles.metaPart}>
          <View style={[styles.personDot, { backgroundColor: personColor(item.subjectUserId) }]} />
          <Txt variant="micro" color={color.textBody}>
            {item.subjectName}
          </Txt>
        </View>
      ) : null}
      {item.placeName ? (
        <Txt variant="micro" color={color.textSubtle} numberOfLines={1}>
          {item.placeName}
        </Txt>
      ) : null}
      {item.fromName ? (
        <Txt variant="micro" color={palette.accentInk}>
          from {item.fromName}
        </Txt>
      ) : null}
      <Mono size={size.monoTiny} color={color.textFaint}>
        {formatWhen(item.at, now)}
      </Mono>
    </View>
  );
}

/** ReminderStatusLine says where a stored reminder stands: "Pending" or "Acknowledged at 08:52". */
export function ReminderStatusLine({ item }: { item: Pick<NotificationItem, 'status' | 'ackedAt'> }) {
  if (!item.status) return null;
  const pending = item.status === 'pending';
  return (
    <View style={[styles.status, { backgroundColor: pending ? color.amberSoft : color.accentSofter }]}>
      <View style={[styles.statusDot, { backgroundColor: pending ? palette.amber : palette.accent }]} />
      <Mono size={size.monoTiny} medium color={pending ? palette.amberInk : palette.accentInk}>
        {pending ? 'PENDING' : `ACKNOWLEDGED${item.ackedAt ? ` AT ${formatClock(item.ackedAt)}` : ''}`}
      </Mono>
    </View>
  );
}

/** formatClock is a 24-hour hh:mm in the device's zone. */
export function formatClock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** formatWhen keeps the panel scannable: "now", "4 min", "13:05", "Mon 13:05". */
export function formatWhen(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const d = new Date(at);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return time;
  return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/**
 * useOpenNotification turns an entry into "show me on the map": it marks the
 * entry read and asks the Live screen to focus the person (who keeps moving, so
 * their marker is followed) or the place. The Shell does the navigation.
 */
export function useOpenNotification() {
  const { data } = useOverview();
  const places = data?.places;
  return useCallback(
    (item: Pick<NotificationItem, 'id' | 'placeId' | 'subjectUserId' | 'deviceId' | 'point'>) => {
      const { markNotificationRead, requestFocus, selectPlace, selectDevice } = useStore.getState();
      markNotificationRead(item.id);
      const target = focusTarget(item);
      if (target.placeId) selectPlace(target.placeId);
      // Selecting a person's device is what makes the map follow them.
      if (target.deviceId) selectDevice(target.deviceId);
      const place = places?.find((p) => p.id === item.placeId);
      // A person is shown where they are; a place where it is (the crossing
      // point is only the fallback for a place this viewer does not own).
      requestFocus({ ...target, point: target.deviceId ? item.point : (place?.center ?? item.point) });
    },
    [places],
  );
}

// ------------------------------------------------------- desktop permission

const permissionListeners = new Set<() => void>();
function subscribePermission(listener: () => void) {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

/** useDesktopPermission exposes the browser's notification permission and a way to ask for it. */
export function useDesktopPermission(): { permission: DesktopPermission; request: () => Promise<void> } {
  const permission = useSyncExternalStore(subscribePermission, desktopPermission, desktopPermission);
  const request = useCallback(async () => {
    await requestDesktop();
    for (const listener of permissionListeners) listener();
  }, []);
  return { permission, request };
}

/** describePermission is the one-line state shown next to the "Enable desktop alerts" button. */
export function describePermission(permission: DesktopPermission): string {
  switch (permission) {
    case 'granted':
      return 'On — alerts appear while this tab is in the background.';
    case 'denied':
      return 'Blocked in this browser. Allow notifications for this site in its settings to turn them on.';
    case 'unsupported':
      return 'Not available here. In-app alerts and sounds still work.';
    default:
      return 'Off — get a system alert when this tab is in the background.';
  }
}

const styles = StyleSheet.create({
  glyph: { alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginTop: 4 },
  metaPart: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  personDot: { width: 7, height: 7, borderRadius: radius.pill },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginTop: 5,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
});
