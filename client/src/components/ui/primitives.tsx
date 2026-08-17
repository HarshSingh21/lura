import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';

import { Mono, Txt } from '@/theme/text';
import { color, font, palette, radius, shadow, size, space, triggerStyle, type TriggerName } from '@/theme/tokens';

import { Icon, type IconName } from './Icon';

/** Card is the white panel used for every list row and grid tile in the mock. */
export function Card({
  children,
  style,
  padded = true,
  onPress,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  padded?: boolean;
  onPress?: () => void;
}) {
  const content = <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
  if (!onPress) return content;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => (pressed ? styles.pressed : undefined)}>
      {content}
    </Pressable>
  );
}

export type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dark';
  icon?: IconName;
  disabled?: boolean;
  loading?: boolean;
  full?: boolean;
  small?: boolean;
  style?: StyleProp<ViewStyle>;
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  icon,
  disabled,
  loading,
  full,
  small,
  style,
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const tone = buttonTone(variant);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      onPress={isDisabled ? undefined : onPress}
      style={({ pressed }) => [
        styles.button,
        small && styles.buttonSmall,
        { backgroundColor: tone.bg, borderColor: tone.border },
        variant === 'primary' && shadow('accent'),
        full && styles.buttonFull,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {icon ? <Icon name={icon} size={15} color={tone.fg} strokeWidth={2} /> : null}
      <Txt
        variant="bodySemi"
        color={tone.fg}
        style={[styles.buttonLabel, small && { fontSize: size.small }]}
        numberOfLines={1}
      >
        {loading ? 'Working…' : label}
      </Txt>
    </Pressable>
  );
}

function buttonTone(variant: NonNullable<ButtonProps['variant']>) {
  switch (variant) {
    case 'primary':
      return { bg: palette.accent, fg: color.textOnAccent, border: palette.accent };
    case 'secondary':
      return { bg: color.surface, fg: color.textStrong, border: color.border };
    case 'ghost':
      return { bg: color.surfaceMuted, fg: color.textMuted, border: 'transparent' };
    case 'danger':
      return { bg: color.surface, fg: palette.dangerInk, border: palette.danger };
    case 'dark':
      return { bg: color.ink, fg: '#ffffff', border: color.ink };
  }
}

/** IconButton is the square map control (zoom, recentre). */
export function IconButton({
  name,
  onPress,
  accessibilityLabel,
  style,
  iconColor = color.textBody,
}: {
  name: IconName;
  onPress?: () => void;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
  iconColor?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed, style]}
    >
      <Icon name={name} size={18} color={iconColor} />
    </Pressable>
  );
}

/** Chip is a tag pill ("grocery", "pass-by"). */
export function Chip({
  label,
  tone = 'neutral',
  mono,
}: {
  label: string;
  tone?: 'neutral' | 'accent' | 'amber';
  mono?: boolean;
}) {
  const tones = {
    neutral: { bg: color.surfaceMuted, fg: color.textMuted },
    accent: { bg: color.accentSoft, fg: palette.accentInk },
    amber: { bg: color.amberTagBg, fg: palette.amberTag },
  } as const;
  const t = tones[tone];
  return (
    <View style={[styles.chip, { backgroundColor: t.bg }]}>
      {mono ? (
        <Mono size={size.monoXs} color={t.fg}>
          {label}
        </Mono>
      ) : (
        <Txt variant="small" color={t.fg} style={{ fontFamily: font.sansMedium }}>
          {label}
        </Txt>
      )}
    </View>
  );
}

/** TriggerBadge renders a trigger in its own colour, uppercase and monospaced. */
export function TriggerBadge({ trigger }: { trigger: TriggerName | string }) {
  const style = triggerStyle[(trigger as TriggerName) in triggerStyle ? (trigger as TriggerName) : 'arrive'];
  const label = triggerStyle[(trigger as TriggerName)]?.label ?? String(trigger).toUpperCase();
  return (
    <View style={[styles.triggerBadge, { backgroundColor: style.bg }]}>
      <Mono size={size.monoTiny} medium color={style.fg} style={styles.triggerText}>
        {label}
      </Mono>
    </View>
  );
}

/** Dot is a small status circle; `pulse` animates it like the mock's live marker. */
export function Dot({
  size: s = 8,
  color: c = palette.accent,
  pulse,
  blink,
  style,
}: {
  size?: number;
  color?: string;
  pulse?: boolean;
  blink?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse && !blink) return;
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: blink ? 1600 : 2000,
        easing: blink ? Easing.inOut(Easing.ease) : Easing.out(Easing.ease),
        // React Native Web has no native animation module; asking for it there
        // warns on every mount and falls back to JS anyway.
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      anim.setValue(0);
    };
  }, [anim, pulse, blink]);

  if (blink) {
    // 1 → 0.35 → 1, the mock's luraBlink keyframes.
    const opacity = anim.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.35, 1] });
    return (
      <Animated.View
        style={[{ width: s, height: s, borderRadius: s / 2, backgroundColor: c, opacity }, style]}
      />
    );
  }

  if (pulse) {
    // A solid core with an expanding, fading ring: luraPulse.
    const scale = anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [1, 2.6, 2.6] });
    const opacity = anim.interpolate({ inputRange: [0, 0.7, 1], outputRange: [0.55, 0, 0] });
    return (
      <View style={[{ width: s, height: s }, style]}>
        <Animated.View
          style={{
            position: 'absolute',
            width: s,
            height: s,
            borderRadius: s / 2,
            backgroundColor: c,
            opacity,
            transform: [{ scale }],
          }}
        />
        <View style={{ width: s, height: s, borderRadius: s / 2, backgroundColor: c }} />
      </View>
    );
  }

  return <View style={[{ width: s, height: s, borderRadius: s / 2, backgroundColor: c }, style]} />;
}

/** Field is a labelled text input. */
export function Field({
  label,
  hint,
  error,
  style,
  inputStyle,
  ...rest
}: Omit<TextInputProps, 'style'> & {
  label?: string;
  hint?: string;
  error?: string;
  /** Wrapper style, so a field can flex inside a row. */
  style?: StyleProp<ViewStyle>;
  inputStyle?: TextInputProps['style'];
}) {
  return (
    <View style={[styles.field, style]}>
      {label ? (
        <Txt variant="small" color={color.textMuted} style={styles.fieldLabel}>
          {label}
        </Txt>
      ) : null}
      <TextInput
        placeholderTextColor={color.textFaint}
        {...rest}
        style={[styles.input, error ? styles.inputError : null, inputStyle]}
      />
      {error ? (
        <Txt variant="micro" color={palette.dangerInk} style={styles.fieldHint}>
          {error}
        </Txt>
      ) : hint ? (
        <Txt variant="micro" color={color.textFaint} style={styles.fieldHint}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** RadioRow is the bordered choice row from the Sharing screen. */
export function RadioRow({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.radioRow,
        selected ? styles.radioRowSelected : null,
        pressed && !selected ? { backgroundColor: color.surfaceHover } : null,
      ]}
    >
      <View style={[styles.radio, selected ? styles.radioSelected : null]} />
      <View style={styles.flex}>
        <Txt variant="bodyMedium" color={selected ? color.textStrong : color.textMuted}>
          {label}
        </Txt>
        {description ? (
          <Txt variant="micro" color={color.textFaint} style={{ marginTop: 2 }}>
            {description}
          </Txt>
        ) : null}
      </View>
    </Pressable>
  );
}

/** Toggle is the settings switch, styled to match the palette rather than the OS. */
export function Toggle({
  value,
  onChange,
  label,
  accessibilityLabel,
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={() => onChange(!value)}
      style={styles.toggleRow}
    >
      <View style={[styles.toggleTrack, value ? styles.toggleTrackOn : null]}>
        <View style={[styles.toggleKnob, value ? styles.toggleKnobOn : null]} />
      </View>
      {label ? (
        <Txt variant="bodyMedium" color={color.textStrong}>
          {label}
        </Txt>
      ) : null}
    </Pressable>
  );
}

/** Checkbox is the note completion box. */
export function Checkbox({ checked, onPress }: { checked: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      onPress={onPress}
      style={[styles.checkbox, checked ? styles.checkboxChecked : null]}
    >
      {checked ? <Icon name="check" size={12} color="#ffffff" /> : null}
    </Pressable>
  );
}

/** Sheet is a centred modal on wide screens and a bottom sheet on a phone. */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  phone,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  phone?: boolean;
}) {
  return (
    <Modal visible={visible} transparent animationType={phone ? 'slide' : 'fade'} onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheetWrap, phone ? styles.sheetWrapPhone : null]} pointerEvents="box-none">
        <View style={[styles.sheet, phone ? styles.sheetPhone : null]}>
          <View style={styles.sheetHeader}>
            <Txt variant="h2">{title}</Txt>
            <IconButton name="close" accessibilityLabel="Close" onPress={onClose} style={styles.sheetClose} />
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** EmptyState explains an empty list instead of leaving a blank panel. */
export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Txt variant="bodySemi" color={color.textMuted}>
        {title}
      </Txt>
      {body ? (
        <Txt variant="tiny" color={color.textFaint} style={styles.emptyBody}>
          {body}
        </Txt>
      ) : null}
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.9 },
  disabled: { opacity: 0.55 },

  card: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.hairline,
    borderRadius: radius.card,
  },
  cardPadded: { padding: space.xl },

  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    borderRadius: radius.lg,
    borderWidth: 1,
    paddingVertical: 10,
    paddingHorizontal: 15,
  },
  buttonSmall: { paddingVertical: 7, paddingHorizontal: 12, borderRadius: radius.md },
  buttonFull: { width: '100%' },
  buttonLabel: { letterSpacing: -0.1 },

  iconButton: {
    width: 38,
    height: 38,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow('button'),
  },

  chip: {
    borderRadius: radius.md,
    paddingVertical: 4,
    paddingHorizontal: 9,
    alignSelf: 'flex-start',
  },

  triggerBadge: {
    borderRadius: radius.sm,
    paddingVertical: 2,
    paddingHorizontal: 7,
    alignSelf: 'flex-start',
  },
  triggerText: { letterSpacing: 0.3 },

  field: { gap: 5 },
  fieldLabel: { fontFamily: font.sansMedium },
  fieldHint: {},
  input: {
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: font.sans,
    fontSize: size.body,
    color: color.textStrong,
    backgroundColor: color.surface,
  },
  inputError: { borderColor: palette.danger },

  radioRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderColor: color.borderInput,
    borderRadius: radius.lg,
    paddingVertical: 11,
    paddingHorizontal: 13,
  },
  radioRowSelected: {
    borderWidth: 1.5,
    borderColor: 'rgba(32,160,123,0.5)',
    backgroundColor: 'rgba(32,160,123,0.07)',
  },
  radio: {
    width: 15,
    height: 15,
    borderRadius: 8,
    borderWidth: 1.5,
    borderColor: 'rgba(20,30,24,0.3)',
  },
  radioSelected: { borderWidth: 4.5, borderColor: palette.accent },

  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  toggleTrack: {
    width: 42,
    height: 24,
    borderRadius: 12,
    backgroundColor: color.surfaceMuted,
    borderWidth: 1,
    borderColor: color.borderInput,
    padding: 2,
    justifyContent: 'center',
  },
  toggleTrackOn: { backgroundColor: color.accentSoft, borderColor: 'rgba(32,160,123,0.4)' },
  toggleKnob: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: color.neutralDot,
  },
  toggleKnobOn: { backgroundColor: palette.accent, transform: [{ translateX: 18 }] },

  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 7,
    borderWidth: 1.5,
    borderColor: color.checkbox,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: palette.accent, borderColor: palette.accent },

  backdrop: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: 'rgba(20,30,24,0.35)',
  },
  sheetWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xxl },
  sheetWrapPhone: { justifyContent: 'flex-end', padding: 0 },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '86%',
    backgroundColor: color.surface,
    borderRadius: radius.cardLg,
    borderWidth: 1,
    borderColor: color.hairline,
    ...shadow('card'),
  },
  sheetPhone: {
    maxWidth: undefined,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xxl,
    paddingTop: space.xxl,
    paddingBottom: space.lg,
  },
  sheetClose: { width: 32, height: 32, borderRadius: radius.md },
  sheetBody: { paddingHorizontal: space.xxl, paddingBottom: space.page, gap: space.xl },

  empty: { paddingVertical: 28, alignItems: 'center', gap: 6 },
  emptyBody: { textAlign: 'center', maxWidth: 320 },
  emptyAction: { marginTop: 8 },
});
