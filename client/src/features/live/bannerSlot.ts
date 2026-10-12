/**
 * Where the live-stream banner ("You are offline", "Reconnecting…") goes on
 * the map, so it covers none of the map's own buttons.
 *
 * The top-left corner belongs to the action row (Draw, Share location) and to
 * what opens under it (the draw menu, a selected place, the follow chip); the
 * right edge to the zoom and basemap controls further down. When the map is
 * wide enough, the banner takes the top-right corner beside the action row and
 * nothing moves. When it is not (a phone), it spans the map under the action
 * row, and whatever opens under that row moves down by the banner's height.
 *
 * Kept free of imports so it is tested with plain `node --test`.
 */

/** Inset of everything on the map from its edges. */
export const MAP_INSET = 16;
/** Space between the action row and the banner beside it, or above it. */
export const BANNER_GAP = 10;
/** The banner never grows wider than this; its text reads best short. */
export const BANNER_MAX_WIDTH = 420;
/** Narrower than this, the two-line message wraps into a tower: go below instead. */
export const BANNER_MIN_WIDTH = 300;

export type BannerSlot =
  | { kind: 'beside'; top: number; right: number; width: number }
  | { kind: 'below'; top: number; left: number; right: number };

/**
 * bannerSlot places the banner for a map `mapWidth` wide whose action row is
 * `actions` (its laid-out size; zero before the first layout).
 */
export function bannerSlot(mapWidth: number, actions: { width: number; height: number }): BannerSlot {
  const room = mapWidth - MAP_INSET * 2 - actions.width - BANNER_GAP;
  if (actions.width > 0 && room >= BANNER_MIN_WIDTH) {
    return { kind: 'beside', top: MAP_INSET, right: MAP_INSET, width: Math.min(BANNER_MAX_WIDTH, room) };
  }
  // Before the action row has a size, assume a button's height rather than
  // drawing the banner over it for a frame.
  const rowHeight = actions.height > 0 ? actions.height : 38;
  return { kind: 'below', top: MAP_INSET + rowHeight + BANNER_GAP, left: MAP_INSET, right: MAP_INSET };
}

/** pushDown is how far what opens under the action row must move for the banner (height `bannerHeight`). */
export function pushDown(slot: BannerSlot | null, bannerHeight: number): number {
  return slot?.kind === 'below' && bannerHeight > 0 ? bannerHeight + BANNER_GAP : 0;
}
