import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { EmptyState } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, layout, palette, radius, shadow, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { selectUnread, useStore } from '@/state/store';

import { filterItems, groupByDay, type NotificationItem } from './model';
import { installAudioUnlock, playChime } from './sound';
import {
  NotificationGlyph,
  NotificationMeta,
  ReminderStatusLine,
  describePermission,
  useDesktopPermission,
  useOpenNotification,
} from './ui';

/**
 * The bell in the top bar and the panel it opens.
 *
 * The panel is "what did I hear about while this was open": every crossing and
 * reminder of the session, newest first, split into today and earlier, with the
 * two controls a noisy afternoon needs within reach — mute, and mark all read.
 * Opening the panel does not mark anything read on its own; an unread dot is only
 * cleared by looking at the entry (tapping it) or by asking.
 */
export function NotificationBell() {
  const unread = useStore(selectUnread);
  const muted = useStore((s) => s.muted);
  const [open, setOpen] = useState(false);

  // The browser will not play the first chime unless a gesture unlocked audio
  // first; arm that as soon as the chrome mounts.
  useEffect(() => {
    installAudioUnlock();
  }, []);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.bell, pressed && styles.pressed]}
      >
        <Icon name={muted ? 'bell-off' : 'bell'} size={18} color={color.textBody} />
        {unread > 0 ? (
          <View style={styles.badge}>
            <Mono size={size.monoTiny} medium color="#ffffff">
              {unread > 99 ? '99+' : unread}
            </Mono>
          </View>
        ) : null}
      </Pressable>
      <NotificationPanel visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

function NotificationPanel({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { isWide } = useLayoutMode();
  const items = useStore((s) => s.notifications);
  const unread = useStore(selectUnread);
  const muted = useStore((s) => s.muted);
  const setMuted = useStore((s) => s.setMuted);
  const markAll = useStore((s) => s.markAllNotificationsRead);
  const clear = useStore((s) => s.clearNotifications);
  const openItem = useOpenNotification();
  const desktop = useDesktopPermission();
  const [filter, setFilter] = useState<'all' | 'pending'>('all');
  const pendingCount = items.reduce((n, i) => (i.status === 'pending' ? n + 1 : n), 0);
  const shownItems = filterItems(items, filter);

  // Regrouped on every render (at most a hundred entries), so "today" is still
  // right when the panel is reopened after midnight.
  const groups = groupByDay(shownItems);
  const show = (item: NotificationItem) => {
    openItem(item);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close notifications" />
      <View style={[styles.panel, isWide ? styles.panelWide : styles.panelPhone]} testID="lura-notification-panel">
        <View style={styles.head}>
          <View style={styles.headTitle}>
            <Txt variant="h2">Notifications</Txt>
            {unread > 0 ? (
              <View style={styles.headCount}>
                <Mono size={size.monoXs} medium color={palette.accentInk}>
                  {unread} new
                </Mono>
              </View>
            ) : null}
          </View>
          <Pressable
            accessibilityRole="switch"
            accessibilityState={{ checked: !muted }}
            accessibilityLabel={muted ? 'Sounds off. Turn notification sounds on' : 'Sounds on. Mute notification sounds'}
            onPress={() => {
              const next = !muted;
              setMuted(next);
              // Unmuting plays a sample, which also proves audio is unlocked.
              if (!next) playChime('arrive');
            }}
            style={({ pressed }) => [styles.headButton, muted && styles.headButtonMuted, pressed && styles.pressed]}
          >
            <Icon name={muted ? 'bell-off' : 'bell'} size={15} color={muted ? palette.dangerInk : color.textBody} />
            <Txt variant="small" color={muted ? palette.dangerInk : color.textBody} style={styles.headButtonText}>
              {muted ? 'Muted' : 'Sound on'}
            </Txt>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onClose} hitSlop={8}>
            <Icon name="close" size={16} color={color.textMuted} />
          </Pressable>
        </View>

        <View style={styles.filterRow} accessibilityRole="tablist">
          {(['all', 'pending'] as const).map((key) => {
            const active = filter === key;
            return (
              <Pressable
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                onPress={() => setFilter(key)}
                style={[styles.filterChip, active && styles.filterChipActive]}
              >
                <Txt variant="small" color={active ? palette.accentInk : color.textMuted} style={styles.link}>
                  {key === 'all' ? 'All' : `Pending${pendingCount > 0 ? ` · ${pendingCount}` : ''}`}
                </Txt>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: unread === 0 }}
            onPress={unread === 0 ? undefined : markAll}
            hitSlop={6}
          >
            <Txt variant="small" color={unread === 0 ? color.textFaint : palette.accentDark} style={styles.link}>
              Mark all read
            </Txt>
          </Pressable>
          {items.length > 0 ? (
            <Pressable accessibilityRole="button" onPress={clear} hitSlop={6}>
              <Txt variant="small" color={color.textSubtle} style={styles.link}>
                Clear
              </Txt>
            </Pressable>
          ) : null}
          <View style={styles.flex} />
          {desktop.permission === 'default' ? (
            <Pressable accessibilityRole="button" onPress={() => void desktop.request()} hitSlop={6}>
              <Txt variant="small" color={palette.accentDark} style={styles.link}>
                Enable desktop alerts
              </Txt>
            </Pressable>
          ) : desktop.permission === 'granted' ? (
            <Mono size={size.monoTiny} color={color.textFaint}>
              DESKTOP ALERTS ON
            </Mono>
          ) : null}
        </View>

        <ScrollView style={styles.list} contentContainerStyle={styles.listInner}>
          {items.length === 0 ? (
            <EmptyState
              title="Nothing yet"
              body="Arrivals, departures and reminders appear here as they happen — yours, and those of people you watch."
            />
          ) : shownItems.length === 0 ? (
            <EmptyState title="Nothing pending" body="Every reminder has been acknowledged." />
          ) : (
            <>
              <Group title="TODAY" items={groups.today} onOpen={show} />
              <Group title="EARLIER" items={groups.earlier} onOpen={show} />
            </>
          )}
        </ScrollView>

        {desktop.permission === 'denied' ? (
          <Txt variant="micro" color={color.textFaint} style={styles.footnote}>
            Desktop alerts: {describePermission(desktop.permission)}
          </Txt>
        ) : null}
      </View>
    </Modal>
  );
}

function Group({
  title,
  items,
  onOpen,
}: {
  title: string;
  items: NotificationItem[];
  onOpen: (item: NotificationItem) => void;
}) {
  if (items.length === 0) return null;
  return (
    <View style={styles.group}>
      <Mono heading color={color.textFaint} style={styles.groupTitle}>
        {title}
      </Mono>
      {items.map((item) => (
        <View key={item.id} style={styles.rowWrap}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.title}${item.read ? '' : ', unread'}${
              item.status === 'pending' ? ', waiting for acknowledgement' : ''
            }. Show on the map.`}
            onPress={() => onOpen(item)}
            style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
              styles.row,
              !item.read && styles.rowUnread,
              (pressed || hovered) && styles.rowHover,
            ]}
          >
            <NotificationGlyph item={item} size={32} />
            <View style={styles.flex}>
              <Txt variant="bodySemi" color={item.read ? color.textBody : color.textStrong} numberOfLines={2}>
                {item.title}
              </Txt>
              {item.body ? (
                <Txt variant="tiny" color={color.textMuted} numberOfLines={2} style={styles.rowBody}>
                  {item.body}
                </Txt>
              ) : null}
              <NotificationMeta item={item} />
              <ReminderStatusLine item={item} />
            </View>
            {!item.read ? <View style={styles.unreadDot} /> : null}
          </Pressable>
          {item.status === 'pending' && item.reminderId ? (
            <AckButton reminderId={item.reminderId} title={item.title} />
          ) : null}
        </View>
      ))}
    </View>
  );
}

function AckButton({ reminderId, title }: { reminderId: string; title: string }) {
  const acknowledge = useStore((s) => s.acknowledgeReminder);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Acknowledge ${title}`}
      onPress={() => void acknowledge(reminderId)}
      style={({ pressed }) => [styles.ack, pressed && styles.pressed]}
    >
      <Icon name="check" size={13} color={palette.accentInk} strokeWidth={2.2} />
      <Txt variant="small" color={palette.accentInk} style={styles.link}>
        Acknowledge
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.85 },

  bell: {
    width: 36,
    height: 34,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: color.borderInput,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -6,
    right: -7,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: palette.danger,
    borderWidth: 2,
    borderColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },

  backdrop: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(20,30,24,0.18)' },
  panel: {
    position: 'absolute',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.cardLg,
    overflow: 'hidden',
    ...shadow('card'),
  },
  panelWide: { top: layout.topBarHeight + 6, right: space.xxl, width: 400, maxHeight: '78%' },
  panelPhone: { top: layout.topBarHeight + 6, left: space.md, right: space.md, maxHeight: '82%' },

  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xxl,
    paddingTop: space.xl,
    paddingBottom: space.md,
  },
  headTitle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.md },
  headCount: { backgroundColor: color.accentSoft, borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 2 },
  headButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  headButtonMuted: { borderColor: palette.danger, backgroundColor: 'rgba(200,101,86,0.08)' },
  headButtonText: { fontFamily: font.sansMedium },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xl,
    paddingHorizontal: space.xxl,
    paddingBottom: space.md,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  link: { fontFamily: font.sansMedium },
  filterRow: { flexDirection: 'row', gap: space.sm, paddingHorizontal: space.xxl, paddingBottom: space.md },
  filterChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.md, backgroundColor: color.surfaceMuted },
  filterChipActive: { backgroundColor: color.accentSoft },
  rowWrap: { gap: 0 },
  ack: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    marginLeft: 32 + space.lg + space.md,
    marginTop: -4,
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.md,
    backgroundColor: color.accentSoft,
  },

  list: { flexGrow: 0 },
  listInner: { padding: space.md, paddingBottom: space.lg },
  group: { gap: 2, marginBottom: space.md },
  groupTitle: { letterSpacing: 0.85, paddingHorizontal: space.md, paddingVertical: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.lg,
    paddingVertical: 10,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
  },
  rowUnread: { backgroundColor: color.accentSofter },
  rowHover: { backgroundColor: color.surfaceHover },
  rowBody: { marginTop: 1 },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: palette.accent, marginTop: 6 },
  footnote: { paddingHorizontal: space.xxl, paddingBottom: space.lg, lineHeight: 15 },
});
