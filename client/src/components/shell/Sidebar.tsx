import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Icon } from '@/components/ui/Icon';
import { Dot } from '@/components/ui/primitives';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, font, layout, palette, radius, size, space } from '@/theme/tokens';

import { NAV_ITEMS, SETTINGS_ITEM, isActive, type NavItem } from './nav';

/**
 * The desktop sidebar.
 *
 * The counters are not decoration: they are the answer to "is anything armed?" at
 * a glance, which is the question a location tracker's operator actually has. The
 * health card at the bottom is the same idea for the deployment itself.
 */
export function Sidebar({
  pathname,
  counts,
  sharing,
  health,
}: {
  pathname: string;
  counts: { devices: number; places: number; notes: number };
  sharing: boolean;
  health: { label: string; detail: string; ok: boolean };
}) {
  return (
    <View style={styles.sidebar}>
      <SectionLabel style={styles.workspaceLabel}>WORKSPACE</SectionLabel>

      {NAV_ITEMS.map((item) => (
        <NavRow
          key={item.key}
          item={item}
          active={isActive(pathname, item.href)}
          badge={badgeFor(item.key, counts)}
          dot={item.key === 'sharing' && sharing}
        />
      ))}

      <View style={styles.footer}>
        <NavRow item={SETTINGS_ITEM} active={isActive(pathname, SETTINGS_ITEM.href)} />

        <View style={styles.health}>
          <Dot size={7} color={health.ok ? palette.accent : palette.amber} />
          <View style={styles.flex}>
            <Txt variant="micro" color={color.textMuted}>
              {health.label}
            </Txt>
            <Mono size={size.monoTiny} color={color.textFaint}>
              {health.detail}
            </Mono>
          </View>
        </View>
      </View>
    </View>
  );
}

function badgeFor(key: string, counts: { devices: number; places: number; notes: number }) {
  switch (key) {
    case 'live':
      return { value: counts.devices, strong: true };
    case 'places':
      return { value: counts.places, strong: false };
    case 'notes':
      return { value: counts.notes, strong: false };
    default:
      return undefined;
  }
}

/**
 * NavRow navigates through the router rather than wrapping the row in <Link
 * asChild>. The anchor Link renders on web is an inline element, and an inline
 * parent collapses this row's flex layout — icon, label and badge end up stacked.
 * Pushing the route by hand keeps the row a block-level flex container on every
 * platform while `accessibilityRole="link"` keeps the semantics.
 */
function NavRow({
  item,
  active,
  badge,
  dot,
}: {
  item: NavItem;
  active: boolean;
  badge?: { value: number; strong: boolean };
  dot?: boolean;
}) {
  const router = useRouter();
  return (
      <Pressable
        accessibilityRole="link"
        accessibilityState={{ selected: active }}
        onPress={() => router.push(item.href)}
        style={({ pressed }) => [
          styles.navRow,
          active && styles.navRowActive,
          pressed && !active && styles.navRowHover,
        ]}
      >
        <Icon name={item.icon} size={18} color={active ? palette.accentNav : color.textBody} />
        <Txt
          variant="body"
          color={active ? palette.accentNav : '#4a514b'}
          style={[styles.navLabel, active && styles.navLabelActive]}
        >
          {item.label}
        </Txt>

        {badge && badge.value > 0 ? (
          badge.strong ? (
            <View style={styles.badgeStrong}>
              <Mono size={size.monoSm} medium color="#ffffff">
                {String(badge.value)}
              </Mono>
            </View>
          ) : (
            <Mono size={size.monoSm} color={color.textFaint} style={styles.badgeSoft}>
              {String(badge.value)}
            </Mono>
          )
        ) : null}

        {dot ? <Dot size={7} color={palette.amberDot} style={styles.sharingDot} /> : null}
      </Pressable>
  );
}

const styles = StyleSheet.create({
  sidebar: {
    width: layout.sidebarWidth,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: color.surface,
    borderRightWidth: 1,
    borderRightColor: color.hairline,
    paddingVertical: space.xl,
    paddingHorizontal: 12,
    gap: 3,
  },
  workspaceLabel: { paddingHorizontal: 10, paddingTop: space.sm, marginBottom: space.md },

  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    width: '100%',
    paddingVertical: 10,
    paddingHorizontal: 11,
    borderRadius: radius.lg,
  },
  navRowActive: { backgroundColor: color.accentSoft },
  navRowHover: { backgroundColor: 'rgba(20,30,24,0.035)' },
  navLabel: { fontFamily: font.sansMedium },
  navLabelActive: { fontFamily: font.sansSemiBold },

  badgeStrong: {
    marginLeft: 'auto',
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: radius.sm + 1,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeSoft: { marginLeft: 'auto' },
  sharingDot: { marginLeft: 'auto' },

  footer: { marginTop: 'auto', gap: 3 },
  health: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 10,
    marginTop: space.sm,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.lg,
  },
  flex: { flex: 1, minWidth: 0 },
});
