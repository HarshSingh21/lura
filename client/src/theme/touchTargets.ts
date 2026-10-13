/**
 * Touch targets.
 *
 * A finger is not a mouse pointer: below 44 × 44 CSS px (Apple's HIG, WCAG 2.5.5)
 * taps start to miss, and on a phone held in one hand they miss a lot. The
 * desktop control centre keeps its compact controls — a mouse hits a 32 px
 * button every time, and the mock's density is the point there — but anywhere
 * a finger is the likely pointer every control grows to at least this size.
 * Usually that is padding around the same visual, not a bigger-looking button.
 */
export const TOUCH_TARGET = 44;

export type TouchEnv = {
  /** iOS or Android: always a finger. */
  native: boolean;
  /** The window's width in px. */
  width: number;
  /** The browser says its primary pointer is coarse (a touch screen). */
  coarsePointer: boolean;
  /** The width the sidebar layout starts at (tokens' layout.wide). */
  wide: number;
};

/**
 * wantsTouchTargets decides whether controls need finger-sized targets: on a
 * native build, on a touch screen, and on the phone/tablet layout (below the
 * sidebar breakpoint) whatever the pointer — that layout is the one a phone gets,
 * so it is designed for one.
 */
export function wantsTouchTargets({ native, width, coarsePointer, wide }: TouchEnv): boolean {
  return native || coarsePointer || width < wide;
}

/** The smallest type a phone reader is asked to read (iOS's own floor for captions). */
export const MIN_TOUCH_TYPE = 11;

/**
 * legibleSize lifts the desktop's 9–10.5 px monospace labels to a size a phone
 * held at arm's length can be read at: +1.5 px, never past MIN_TOUCH_TYPE, and
 * nothing that is already that size changes.
 */
export function legibleSize(px: number): number {
  return px >= MIN_TOUCH_TYPE ? px : Math.min(MIN_TOUCH_TYPE, px + 1.5);
}

/** touchTarget is the style that makes a control at least TOUCH_TARGET in both directions. */
export const touchTarget = { minHeight: TOUCH_TARGET, minWidth: TOUCH_TARGET } as const;
