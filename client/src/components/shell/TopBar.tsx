import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Dot } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, font, layout, palette, radius, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import type { LiveStatus } from '@/api/live';

/**
 * The top bar: identity, search, the airgap switch and the account chip.
 *
 * The airgap control is deliberately here rather than buried in settings. HLD §11
 * makes "no outbound calls" a product-defining invariant and requires it to be
 * surfaced in the UI — a privacy switch nobody can find is not a privacy switch.
 */
export function TopBar({
  airgap,
  onToggleAirgap,
  initials,
  status,
  search,
  onSearchChange,
  onSearchSubmit,
  aiEngine,
}: {
  airgap: boolean;
  onToggleAirgap: () => void;
  initials: string;
  status: LiveStatus;
  search: string;
  onSearchChange: (next: string) => void;
  onSearchSubmit?: () => void;
  aiEngine?: string;
}) {
  const { isWide, isDesktop } = useLayoutMode();

  return (
    <View style={styles.bar}>
      <View style={[styles.brand, isDesktop && styles.brandDesktop]}>
        <View style={styles.logo}>
          <View style={styles.logoCore} />
          <Dot size={28} color={palette.accent} pulse style={styles.logoPulse} />
        </View>
        <Txt style={styles.wordmark}>Lura</Txt>
        {isWide ? (
          <View style={styles.selfHosted}>
            <Mono size={size.monoTiny} color={color.textSubtle}>
              self-hosted
            </Mono>
          </View>
        ) : null}
      </View>

      {isWide ? (
        <View style={styles.search}>
          <Icon name="search" size={15} color={color.textSubtle} />
          <TextInput
            value={search}
            onChangeText={onSearchChange}
            onSubmitEditing={onSearchSubmit}
            placeholder="Search places, addresses, or Plus Codes…"
            placeholderTextColor={color.textSubtle}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {/* Geocoding is Photon (HLD §13); naming it sets the expectation that
              search is self-hosted too. */}
          <Mono size={size.monoTiny} color={color.textFaint}>
            {aiEngine === 'minilm' ? 'Photon · MiniLM' : 'Photon'}
          </Mono>
        </View>
      ) : (
        <View style={styles.flexSpacer} />
      )}

      <View style={styles.right}>
        <StatusPill status={status} compact={!isWide} />

        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: airgap }}
          accessibilityLabel="Airgap mode"
          onPress={onToggleAirgap}
          style={({ pressed }) => [styles.airgap, airgap && styles.airgapOn, pressed && styles.pressed]}
        >
          <Dot size={8} color={airgap ? palette.accent : color.timelineNode} />
          {isWide ? (
            <Txt variant="small" color={airgap ? palette.accentAirgap : color.textMuted} style={styles.airgapLabel}>
              Airgap {airgap ? 'on' : 'off'}
            </Txt>
          ) : null}
        </Pressable>

        {isWide ? <View style={styles.divider} /> : null}

        <View style={styles.avatar}>
          <Txt variant="small" color={palette.accentInk} style={styles.avatarText}>
            {initials}
          </Txt>
        </View>
      </View>
    </View>
  );
}

/** StatusPill shows the live connection state, so "the map stopped moving" is answerable. */
function StatusPill({ status, compact }: { status: LiveStatus; compact?: boolean }) {
  const tone =
    status === 'open'
      ? { dot: palette.accent, label: 'Live', color: palette.accentAirgap }
      : status === 'connecting' || status === 'reconnecting'
        ? { dot: palette.amber, label: 'Reconnecting', color: palette.amberInk }
        : { dot: color.timelineNode, label: 'Offline', color: color.textMuted };

  return (
    <View style={styles.status}>
      <Dot size={7} color={tone.dot} blink={status === 'connecting' || status === 'reconnecting'} />
      {compact ? null : (
        <Mono size={size.monoXs} color={tone.color}>
          {tone.label}
        </Mono>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: layout.topBarHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    paddingHorizontal: space.xxl,
    backgroundColor: color.surface,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
    zIndex: 20,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandDesktop: { minWidth: 210 },
  logo: {
    width: 28,
    height: 28,
    borderRadius: 9,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCore: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#ffffff' },
  logoPulse: { position: 'absolute', opacity: 0.6 },
  wordmark: { fontFamily: font.sansBold, fontSize: 18, letterSpacing: -0.36 },
  selfHosted: {
    borderWidth: 1,
    borderColor: color.hairlineStrong,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },

  search: {
    flex: 1,
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    backgroundColor: color.surfaceMuted,
    borderWidth: 1,
    borderColor: color.hairlineSoft,
    borderRadius: radius.xl,
    paddingHorizontal: 13,
    paddingVertical: 9,
  },
  searchInput: {
    flex: 1,
    fontFamily: font.sans,
    fontSize: size.body,
    color: color.textStrong,
    // Remove the web input's focus ring; the container carries the affordance.
    outlineStyle: 'none' as never,
  },
  flexSpacer: { flex: 1 },

  right: { marginLeft: 'auto', flexDirection: 'row', alignItems: 'center', gap: 12 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  airgap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: color.borderInput,
    backgroundColor: color.surface,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  airgapOn: { borderColor: 'rgba(32,160,123,0.4)', backgroundColor: color.accentSofter },
  airgapLabel: { fontFamily: font.sansMedium },
  pressed: { opacity: 0.9 },

  divider: { width: 1, height: 24, backgroundColor: color.border },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(32,160,123,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontFamily: font.sansSemiBold },
});
