import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/Icon';
import { Dot } from '@/components/ui/primitives';
import { Txt } from '@/theme/text';
import { color, font, palette, space } from '@/theme/tokens';

import { NAV_ITEMS, SETTINGS_ITEM, isActive } from './nav';

/**
 * The phone tab bar.
 *
 * Six sidebar entries do not fit a phone, so Settings joins the five primary
 * destinations as "More" and the labels shorten. The insets matter: on a device
 * with a home indicator, a tab bar flush to the bottom edge is unreachable.
 */
export function BottomTabs({ pathname, sharing }: { pathname: string; sharing: boolean }) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const items = [...NAV_ITEMS, SETTINGS_ITEM];

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.md) }]}>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
            <Pressable
              key={item.key}
              accessibilityRole="link"
              accessibilityState={{ selected: active }}
              accessibilityLabel={item.label}
              onPress={() => router.push(item.href)}
              style={styles.tab}
            >
              <View style={styles.iconWrap}>
                <Icon name={item.icon} size={20} color={active ? palette.accent : color.textSubtle} />
                {item.key === 'sharing' && sharing ? (
                  <Dot size={6} color={palette.amberDot} style={styles.sharingDot} />
                ) : null}
              </View>
              <Txt variant="micro" color={active ? palette.accentNav : color.textSubtle} style={styles.label}>
                {item.short}
              </Txt>
            </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
    paddingTop: space.md,
  },
  tab: { flex: 1, alignItems: 'center', gap: 3 },
  iconWrap: { width: 24, height: 24, alignItems: 'center', justifyContent: 'center' },
  sharingDot: { position: 'absolute', top: 0, right: 0 },
  label: { fontFamily: font.sansMedium, fontSize: 10.5 },
});
