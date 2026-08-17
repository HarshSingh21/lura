/**
 * Design tokens, taken directly from the Lura design mock.
 *
 * The mock expresses colour in `oklch()`. React Native's style engine cannot
 * parse that (and neither can older Safari), so every value here is the exact
 * sRGB conversion of the mock's oklch triplet — the original is kept in a
 * comment so a designer changing the mock can find the matching token.
 *
 * Everything else (spacing, radii, type scale) is transcribed from the mock's
 * inline styles rather than re-invented, because the layout is the spec.
 */

/** withAlpha returns `#rrggbb` as an rgba() string. */
export function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const palette = {
  /** oklch(0.63 0.12 168) — the brand green: live dots, primary buttons, fences */
  accent: '#20a07b',
  /** oklch(0.55 0.12 168) — links, map strokes */
  accentDark: '#008764',
  /** oklch(0.45 0.12 168) — trigger chips */
  accentDeep: '#006948',
  /** oklch(0.42 0.1 168) — avatar text, suggestion chip text */
  accentInk: '#005e42',
  /** oklch(0.38 0.1 168) — active nav label */
  accentNav: '#005238',
  /** oklch(0.4 0.1 168) — airgap button text when on */
  accentAirgap: '#00583d',
  /** oklch(0.5 0.1 168) — trip mode label */
  accentMode: '#057558',
  /** oklch(0.7 0.15 165) — the bright pulse on a live marker */
  accentBright: '#00bb87',

  /** oklch(0.72 0.13 60) — sharing amber */
  amber: '#df8f48',
  /** oklch(0.62 0.13 60) — dashed pass-by fence */
  amberDark: '#be7125',
  /** oklch(0.66 0.13 55) — blinking "you are sharing" dot */
  amberDot: '#ce7a3b',
  /** oklch(0.46 0.11 50) — sharing banner text */
  amberInk: '#874213',
  /** oklch(0.5 0.13 55) — pass-by tag text */
  amberTag: '#994a00',

  /** oklch(0.62 0.13 30) — revoke hover border */
  danger: '#c86556',
  /** oklch(0.5 0.13 30) — revoke hover text */
  dangerInk: '#a04034',
} as const;

export const color = {
  /** page background behind the panels */
  bg: '#f5f6f3',
  surface: '#ffffff',
  /** search field, tag pills, secondary buttons */
  surfaceMuted: '#f0f2ee',
  /** row hover */
  surfaceHover: '#f7f8f5',
  surfacePressed: '#e6e9e2',

  /** map canvas and its features */
  mapBg: '#e8ebe4',
  mapBlock: '#eff1ec',
  mapPark: '#dbe6cf',
  mapWater: '#cfe0e6',
  mapArterial: '#f2ead6',
  mapRoad: '#ffffff',

  /** dark surfaces: the share preview and the airgap banner */
  ink: '#17201b',
  inkPanel: '#232d27',
  inkPanelLine: '#3a463f',
  inkPanelText: '#c8d2cc',
  inkPanelMuted: '#9aa79f',
  inkPanelFaint: '#7f8b83',

  text: '#17201b',
  textStrong: '#17201b',
  textBody: '#3a423c',
  textMuted: '#6d746e',
  textSubtle: '#8a918b',
  textFaint: '#a4aaa3',
  textOnAccent: '#ffffff',

  /** idle device swatch */
  neutralDot: '#9aa39b',
  neutralChip: '#eef0ec',
  timelineNode: '#c2c9c1',

  hairline: withAlpha('#141e18', 0.09),
  hairlineSoft: withAlpha('#141e18', 0.08),
  hairlineStrong: withAlpha('#141e18', 0.14),
  border: withAlpha('#141e18', 0.1),
  borderInput: withAlpha('#141e18', 0.12),
  checkbox: withAlpha('#141e18', 0.22),
  scrollThumb: withAlpha('#141e18', 0.16),

  accent: palette.accent,
  accentSoft: withAlpha(palette.accent, 0.12),
  accentSofter: withAlpha(palette.accent, 0.1),
  accentFence: withAlpha(palette.accent, 0.14),
  accentFenceLine: withAlpha(palette.accent, 0.45),
  accentGlow: withAlpha(palette.accent, 0.35),
  accentCorridor: withAlpha(palette.accent, 0.16),

  amber: palette.amber,
  amberSoft: withAlpha(palette.amber, 0.1),
  amberSofter: withAlpha(palette.amber, 0.08),
  amberBorder: withAlpha(palette.amber, 0.35),
  amberBorderStrong: withAlpha(palette.amber, 0.4),
  amberFence: withAlpha(palette.amber, 0.12),
  amberFenceLine: withAlpha(palette.amberDark, 0.55),
  amberTagBg: withAlpha(palette.amber, 0.18),
} as const;

export const font = {
  /** Space Grotesk carries the product voice; JetBrains Mono every number and id. */
  sans: 'SpaceGrotesk_400Regular',
  sansMedium: 'SpaceGrotesk_500Medium',
  sansSemiBold: 'SpaceGrotesk_600SemiBold',
  sansBold: 'SpaceGrotesk_700Bold',
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

/** Type sizes, transcribed from the mock's inline styles. */
export const size = {
  h1: 24,
  h2: 19,
  cardTitle: 15,
  body: 13.5,
  bodySm: 13,
  label: 12.5,
  small: 12,
  tiny: 11.5,
  micro: 11,
  monoSm: 10.5,
  monoXs: 9.5,
  monoTiny: 9,
} as const;

export const radius = {
  sm: 5,
  md: 8,
  lg: 10,
  xl: 11,
  card: 12,
  cardLg: 14,
  pill: 999,
} as const;

export const space = {
  xs: 4,
  sm: 6,
  md: 8,
  lg: 11,
  xl: 14,
  xxl: 18,
  page: 26,
  pageX: 30,
} as const;

export const layout = {
  topBarHeight: 58,
  sidebarWidth: 224,
  railWidth: 328,
  historyRailWidth: 360,
  /** Above this width the desktop control centre (sidebar + rail) is shown. */
  desktop: 1080,
  /** Above this width the sidebar is shown; below it, bottom tabs. */
  wide: 840,
} as const;

/** shadow returns a cross-platform elevation matching the mock's box-shadows. */
export function shadow(level: 'card' | 'float' | 'button' | 'accent') {
  switch (level) {
    case 'card':
      return {
        shadowColor: '#141e18',
        shadowOpacity: 0.07,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 3 },
        elevation: 2,
      } as const;
    case 'float':
      return {
        shadowColor: '#141e18',
        shadowOpacity: 0.1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 2 },
        elevation: 3,
      } as const;
    case 'button':
      return {
        shadowColor: '#141e18',
        shadowOpacity: 0.1,
        shadowRadius: 7,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
      } as const;
    case 'accent':
      return {
        shadowColor: palette.accent,
        shadowOpacity: 0.35,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
        elevation: 4,
      } as const;
  }
}

/** Trigger colours, so a trigger looks the same everywhere it appears. */
export const triggerStyle = {
  arrive: { bg: color.accentSoft, fg: palette.accentDeep, label: 'ARRIVE' },
  leave: { bg: color.accentSoft, fg: palette.accentDeep, label: 'LEAVE' },
  dwell: { bg: color.accentSoft, fg: palette.accentDeep, label: 'DWELL' },
  passby: { bg: color.amberTagBg, fg: palette.amberTag, label: 'PASS-BY' },
} as const;

export type TriggerName = keyof typeof triggerStyle;
