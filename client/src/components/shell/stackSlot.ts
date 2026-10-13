/**
 * Where the toast and reminder stack goes, per layout and screen, so a sticky
 * reminder card — which stays until acknowledged, across every screen — never
 * sits on a screen's own controls.
 *
 *   - Desktop: top right, as wide as the right rail it covers. On the Live map
 *     that rail is the people list, which the cards stand in for while they are
 *     up. On History the right column is the timeline, whose head holds the day
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
};

/** The wide layout's stack width: a card's natural reading width. */
export const WIDE_STACK_WIDTH = 380;
/** Room on the right for the map's control column (18 px inset + 38 px buttons + a gap). */
export const CONTROLS_LANE = 64;
/** Tab bar (≈58 px) plus the live map's collapsed people sheet and a gap. */
export const PHONE_STACK_BOTTOM = 128;

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
    return { top: 'auto', left: m.inset, right: CONTROLS_LANE, bottom: PHONE_STACK_BOTTOM };
  }
  const top = m.topBarHeight + m.gap;
  if (mode === 'wide') return { top, right: m.wideInset, width: WIDE_STACK_WIDTH };
  const width = m.railWidth - m.inset * 2;
  if (isHistory(pathname)) {
    return { top: 'auto', bottom: m.inset, right: m.historyRailWidth + m.inset, width };
  }
  return { top, right: m.inset, width };
}
