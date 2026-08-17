import { StyleSheet, Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { color, font, size } from './tokens';

/**
 * Typed text primitives.
 *
 * React Native has no font-weight inheritance across custom font families: you
 * pick the family that *is* the weight. Wrapping that in named components keeps
 * every screen from re-deriving "600 weight is SpaceGrotesk_600SemiBold", and
 * makes a weight change a one-line edit here.
 */

type Variant =
  | 'h1'
  | 'h2'
  | 'cardTitle'
  | 'body'
  | 'bodyMedium'
  | 'bodySemi'
  | 'label'
  | 'small'
  | 'tiny'
  | 'micro';

const variants: Record<Variant, TextStyle> = {
  h1: { fontFamily: font.sansBold, fontSize: size.h1, letterSpacing: -0.5, color: color.textStrong },
  h2: { fontFamily: font.sansBold, fontSize: size.h2, letterSpacing: -0.38, color: color.textStrong },
  cardTitle: { fontFamily: font.sansSemiBold, fontSize: size.cardTitle, color: color.textStrong },
  body: { fontFamily: font.sans, fontSize: size.body, color: color.textStrong },
  bodyMedium: { fontFamily: font.sansMedium, fontSize: size.body, color: color.textStrong },
  bodySemi: { fontFamily: font.sansSemiBold, fontSize: size.bodySm, color: color.textStrong },
  label: { fontFamily: font.sansMedium, fontSize: size.label, color: color.textMuted },
  small: { fontFamily: font.sans, fontSize: size.small, color: color.textMuted },
  tiny: { fontFamily: font.sans, fontSize: size.tiny, color: color.textSubtle },
  micro: { fontFamily: font.sans, fontSize: size.micro, color: color.textSubtle },
};

export type TxtProps = TextProps & {
  variant?: Variant;
  color?: string;
};

export function Txt({ variant = 'body', color: c, style, ...rest }: TxtProps) {
  return <RNText {...rest} style={[variants[variant], c ? { color: c } : null, style]} />;
}

export type MonoProps = TextProps & {
  size?: number;
  color?: string;
  medium?: boolean;
  /** Uppercase section headings ("MY DEVICES") carry wide tracking in the mock. */
  heading?: boolean;
};

export function Mono({ size: s = size.monoXs, color: c, medium, heading, style, ...rest }: MonoProps) {
  return (
    <RNText
      {...rest}
      style={[
        {
          fontFamily: medium ? font.monoMedium : font.mono,
          fontSize: heading ? size.monoTiny : s,
          color: c ?? (heading ? color.textFaint : color.textSubtle),
        },
        heading ? styles.heading : null,
        style,
      ]}
    />
  );
}

/** SectionLabel is the "MY DEVICES" / "ACTIVE SHARES" rail heading. */
export function SectionLabel({ children, style }: { children: string; style?: TextStyle }) {
  return (
    <Mono heading style={[styles.sectionLabel, style]}>
      {children}
    </Mono>
  );
}

const styles = StyleSheet.create({
  heading: {
    letterSpacing: 0.85,
  },
  sectionLabel: {
    marginBottom: 10,
  },
});
