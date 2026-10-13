import { usePathname } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Dot } from '@/components/ui/primitives';
import { ReminderCards } from '@/features/notify/ReminderCards';
import { NotificationGlyph, NotificationMeta, tintFor, useOpenNotification } from '@/features/notify/ui';
import { Txt } from '@/theme/text';
import { color, layout, palette, radius, shadow, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { useStore, type Toast } from '@/state/store';

import { stackSlot, type StackMetrics } from './stackSlot';

/**
 * Live toasts.
 *
 * When a geofence fires, the in-app channel pushes the reminder down the socket
 * (HLD §5.6) — this is where it surfaces. A crossing toast says who, what and
 * where at a glance: the trigger's glyph tinted in the person's colour, the note
 * text, and a meta line ("Nishtha · Grocery · from Harsh"). Tapping it shows that
 * person or place on the Live map.
 *
 * A reminder that waits for an acknowledgement is not a toast: it is a sticky
 * card (features/notify/ReminderCards) at the top of this stack. Other
 * reminders auto-dismiss but stay long enough to read while driving past the shop
 * they are about, and a thin bar shows how long is left; errors stay until
 * dismissed, because an error nobody saw is an error nobody fixed.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const pending = useStore((s) => s.reminders.cards.length);
  const { mode } = useLayoutMode();
  const pathname = usePathname();

  if (toasts.length === 0 && pending === 0) return null;

  // Wide: under the bell, where the notification centre opens, so a toast reads
  // as "new in there" and never sits on the map's zoom and locate controls; on
  // the desktop layout it is exactly as wide as the right rail it covers, so it
  // never hides any of the map either — except on History, whose rail head is
  // the day picker, where it sits on the map instead. Phone: above the tab bar,
  // within reach of a thumb, with a lane kept clear for the map's control
  // column. The rules are in stackSlot.ts.
  const slot = stackSlot(mode, pathname, METRICS);
  return (
    <View style={[styles.stack, slot]} pointerEvents="box-none">
      {/* Pending reminders sit above the passing toasts and outlast them. */}
      <ReminderCards />
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} fromTop={slot.top !== 'auto'} />
      ))}
    </View>
  );
}

const native = Platform.OS !== 'web';

const METRICS: StackMetrics = {
  topBarHeight: layout.topBarHeight,
  railWidth: layout.railWidth,
  historyRailWidth: layout.historyRailWidth,
  inset: space.lg,
  wideInset: space.xxl,
  gap: space.md,
};

function ToastCard({ toast, fromTop }: { toast: Toast; fromTop: boolean }) {
  // A stable callback, so a new toast arriving does not restart this one's timer.
  const id = toast.id;
  const onDismiss = useCallback(() => useStore.getState().dismissToast(id), [id]);
  const item = useStore((s) =>
    toast.notificationId ? s.notifications.find((n) => n.id === toast.notificationId) : undefined,
  );
  const open = useOpenNotification();
  const sticky = toast.kind === 'error';
  const lifetime = item ? 9000 : 5000;

  // useState rather than useRef: the values are created once and never reassigned.
  const [enter] = useState(() => new Animated.Value(0));
  const [progress] = useState(() => new Animated.Value(1));

  useEffect(() => {
    // A quick ease-out rather than a spring: a soft spring spends most of a
    // second near-transparent, which is exactly when someone glances at it.
    Animated.timing(enter, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: native }).start();
  }, [enter]);

  useEffect(() => {
    if (sticky) return;
    progress.setValue(1);
    const bar = Animated.timing(progress, {
      toValue: 0,
      duration: lifetime,
      easing: Easing.linear,
      // Width cannot be driven natively; scaleX can, but RN Web ignores the
      // native driver anyway, so keep one code path.
      useNativeDriver: native,
    });
    bar.start();
    const timer = setTimeout(onDismiss, lifetime);
    return () => {
      bar.stop();
      clearTimeout(timer);
    };
    // Re-arm when the second frame for a crossing re-words the toast: the reader
    // deserves the full time to read the note text.
  }, [onDismiss, sticky, lifetime, progress, toast.title, toast.body]);

  const animated = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [fromTop ? -14 : 16, 0] }) }],
  };

  if (item) {
    const tint = tintFor(item);
    return (
      <Animated.View style={animated}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${toast.title}. Show on the map.`}
          // Names the crossing, so a toast and the reminder card that replaces
          // it read as one notice (the e2e suite counts them by it).
          testID={`lura-notice-${item.id}`}
          onPress={() => {
            open(item);
            onDismiss();
          }}
          style={({ pressed }) => [styles.toast, styles.rich, { borderLeftColor: tint }, pressed && styles.pressed]}
        >
          <NotificationGlyph item={item} />
          <View style={styles.body}>
            <Txt variant="bodySemi" numberOfLines={2}>
              {toast.title}
            </Txt>
            {toast.body ? (
              <Txt variant="tiny" color={color.textMuted} style={styles.bodyText} numberOfLines={3}>
                {toast.body}
              </Txt>
            ) : null}
            <NotificationMeta item={item} />
          </View>
          <DismissButton onDismiss={onDismiss} />
          <Progress progress={progress} tint={tint} />
        </Pressable>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={animated}>
      <View style={[styles.toast, toast.kind === 'error' && styles.toastError]}>
        <Dot size={8} color={plainTint(toast)} style={styles.dot} />
        <View style={styles.body}>
          <Txt variant="bodySemi" numberOfLines={2}>
            {toast.title}
          </Txt>
          {toast.body ? (
            <Txt variant="tiny" color={color.textMuted} style={styles.bodyText} numberOfLines={4}>
              {toast.body}
            </Txt>
          ) : null}
        </View>
        <DismissButton onDismiss={onDismiss} />
      </View>
    </Animated.View>
  );
}

function plainTint(toast: Toast): string {
  if (toast.kind === 'error') return palette.danger;
  if (toast.kind === 'reminder') return palette.accent;
  return color.textSubtle;
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Dismiss" onPress={onDismiss} hitSlop={8}>
      <Icon name="close" size={14} color={color.textFaint} />
    </Pressable>
  );
}

function Progress({ progress, tint }: { progress: Animated.Value; tint: string }) {
  return (
    <View style={styles.progressTrack} pointerEvents="none">
      <Animated.View
        style={[
          styles.progressBar,
          { backgroundColor: tint, transform: [{ scaleX: progress }] },
          // scaleX shrinks around the centre; anchor it on the left.
          Platform.OS === 'web' ? ({ transformOrigin: 'left' } as object) : null,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    position: 'absolute',
    gap: space.md,
    zIndex: 60,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: 12,
    paddingHorizontal: 14,
    overflow: 'hidden',
    ...shadow('card'),
  },
  rich: { borderLeftWidth: 4, gap: 12, paddingBottom: 14 },
  toastError: { borderColor: palette.danger },
  pressed: { opacity: 0.92 },
  dot: { marginTop: 5 },
  body: { flex: 1, minWidth: 0 },
  bodyText: { marginTop: 2 },
  progressTrack: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, backgroundColor: color.hairline },
  progressBar: { height: 3, width: '100%', opacity: 0.7 },
});
