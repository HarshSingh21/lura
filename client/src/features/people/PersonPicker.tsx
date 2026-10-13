import { Pressable, StyleSheet, View } from 'react-native';

import { Icon } from '@/components/ui/Icon';
import { Txt } from '@/theme/text';
import { color, font, radius, withAlpha } from '@/theme/tokens';
import { useTouchTargets } from '@/theme/touch';

import { personColor } from './color';
import { firstName } from './peer';
import type { Peer } from './types';

/**
 * PersonPicker is a row of people as selectable pills — single choice ("whose
 * movement") or several ("notify"). Each pill carries the person's colour dot, so
 * the composer, the toast and the map agree on who is who.
 *
 * An option can be present but disabled with a reason ("not sharing with you"):
 * hiding a connected person would leave the reader wondering where they went.
 */

export type PersonOption = {
  id: string;
  label: string;
  /** Colour dot; omitted for "me", which wears the brand colour. */
  color?: string;
  disabled?: boolean;
  /** Why it is disabled, shown under the label. */
  hint?: string;
};

export function PersonPicker({
  options,
  selected,
  onToggle,
  multiple,
  accessibilityLabel,
}: {
  options: PersonOption[];
  selected: string[];
  onToggle: (id: string) => void;
  multiple?: boolean;
  accessibilityLabel: string;
}) {
  const touch = useTouchTargets();
  return (
    <View style={styles.row} accessibilityLabel={accessibilityLabel} accessibilityRole={multiple ? undefined : 'radiogroup'}>
      {options.map((option) => {
        const on = selected.includes(option.id);
        const tint = option.color ?? color.accent;
        return (
          <Pressable
            key={option.id}
            accessibilityRole={multiple ? 'checkbox' : 'radio'}
            aria-checked={on}
            aria-disabled={!!option.disabled}
            accessibilityLabel={option.hint ? `${option.label}, ${option.hint}` : option.label}
            onPress={option.disabled ? undefined : () => onToggle(option.id)}
            style={({ pressed }) => [
              styles.pill,
              touch && styles.pillTouch,
              on && { borderColor: tint, backgroundColor: withAlpha(hex(tint), 0.1) },
              option.disabled && styles.disabled,
              pressed && !option.disabled && styles.pressed,
            ]}
          >
            <View style={[styles.dot, { backgroundColor: tint }]}>
              {on ? <Icon name="check" size={8} color="#ffffff" /> : null}
            </View>
            <View>
              <Txt variant="small" color={on ? color.textStrong : color.textBody} style={styles.label}>
                {option.label}
              </Txt>
              {option.hint ? (
                <Txt variant="micro" color={color.textFaint}>
                  {option.hint}
                </Txt>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/** withAlpha wants #rrggbb; the brand token already is one, person colours too. */
function hex(value: string): string {
  return value.startsWith('#') && value.length === 7 ? value : '#20a07b';
}

/** peerOption renders a connection as a picker option. */
export function peerOption(peer: Peer, opts?: { requireSharing?: boolean }): PersonOption {
  const notSharing = opts?.requireSharing && !peer.sharingWithMe;
  return {
    id: peer.peerId,
    label: firstName(peer),
    color: personColor(peer.peerId),
    disabled: notSharing,
    hint: notSharing ? 'not sharing with you' : undefined,
  };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingLeft: 6,
    paddingRight: 11,
    backgroundColor: color.surface,
  },
  // A finger-sized pill (theme/touch).
  pillTouch: { minHeight: 44, paddingLeft: 10, paddingRight: 15, gap: 8 },
  dot: { width: 14, height: 14, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  label: { fontFamily: font.sansMedium },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.85 },
});
