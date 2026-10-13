/**
 * Where the toast and reminder stack goes, per layout and screen, so a sticky
 * reminder card — which stays until acknowledged, across every screen — never
 * sits on a screen's own controls.
 *
 *   - Desktop: top right, as wide as the right rail it covers. On the Live map
 *     that rail is the people list, which moves down below the sticky cards
 *     while they are up (railTopPadding). On History the right column is the timeline, whose head holds the day
 *     picker: there the stack moves onto the map, bottom right, clear of the
 *     rail and of the map's own basemap button at the top.
 *   - Wide (sidebar, no rail): top right, under the bell.
 *   - Phone: at the bottom, above the tab bar and the live map's people sheet,
 *     with a lane kept clear for the map's control column.
 *
 * Kept free of imports so it is tested with plain `node --test`; Toasts.tsx
 * passes the layout tokens in.
 */

export type StackMetrics = {
  topBarHeight: number;
  railWidth: number;
  historyRailWidth: number;
  /** Inset from the edges it is pinned to. */
  inset: number;
  /** The wide layout's right inset, under the bell. */
  wideInset: number;
  /** The gap between the bar and the stack below it. */
  gap: number;
};

export type StackSlot = {
  top?: number | 'auto';
  bottom?: number;
  left?: number;
  right: number;
  width?: number;
  maxWidth?: number;
};

/** The wide layout's stack width: a card's natural reading width. */
export const WIDE_STACK_WIDTH = 380;
/** Room on the right for the map's control column (18 px inset + 38 px buttons + a gap). */
export const CONTROLS_LANE = 64;
/**
 * Tab bar (56 px), the live map's collapsed people sheet and the map credit
 * above it, and a gap: the "+N more" pill under a reminder card printed over
 * the OpenStreetMap credit, which the tiles' licence says must stay readable.
 * The credit is two lines on any phone and sits just above the sheet
 * (LiveScreen's attributionPhone), so it stays below this line.
 */
export const PHONE_STACK_BOTTOM = 162;
/** On a tablet the phone layout's corner holds a card's width, not the screen's. */
export const PHONE_STACK_MAX_WIDTH = 440;

/** isHistory says whether a pathname is the History screen. */
function isHistory(pathname: string | undefined): boolean {
  return !!pathname && /^\/history(\/|$)/.test(pathname);
}

/**
 * stackSlot is the stack's absolute position for a layout mode and the current
 * route. 'auto', not undefined, for a top that must not apply: an undefined
 * style is dropped when styles merge.
 */
export function stackSlot(mode: 'phone' | 'wide' | 'desktop', pathname: string | undefined, m: StackMetrics): StackSlot {
  if (mode === 'phone') {
    return { top: 'auto', left: m.inset, right: CONTROLS_LANE, bottom: PHONE_STACK_BOTTOM, maxWidth: PHONE_STACK_MAX_WIDTH };
  }
  const top = m.topBarHeight + m.gap;
  if (mode === 'wide') return { top, right: m.wideInset, width: WIDE_STACK_WIDTH };
  const width = m.railWidth - m.inset * 2;
  if (isHistory(pathname)) {
    return { top: 'auto', bottom: m.inset, right: m.historyRailWidth + m.inset, width };
  }
  return { top, right: m.inset, width };
}

/**
 * coversRail says whether the stack sits over the right rail: the desktop
 * layout everywhere but History, whose stack moves onto the map.
 */
export function coversRail(mode: 'phone' | 'wide' | 'desktop', pathname: string | undefined): boolean {
  return mode === 'desktop' && !isHistory(pathname);
}

/**
 * railTopPadding is the Live rail's top padding while sticky reminder cards
 * `cover` px tall sit over it: their height, the gap above them and the rail's
 * own padding, so the first row starts below the cards instead of peeking out
 * from under them half hidden (and under the "+N more" pill). With no card up
 * it is the rail's own padding.
 */
export function railTopPadding(cover: number, base: number, m: Pick<StackMetrics, 'gap'>): number {
  return cover > 0 ? m.gap + Math.ceil(cover) + base : base;
}
