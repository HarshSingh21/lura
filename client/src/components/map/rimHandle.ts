/**
 * Where a circle's resize handle sits on its rim.
 *
 * It used to be due east, always. Every layout keeps the map's control column
 * (basemap, zoom, locate) down the right-hand edge, so a circle that reached
 * that edge — easily, on a 390 px phone — put its only resize handle under the
 * buttons, where a finger hit the basemap picker instead. The handle now takes
 * the first side of the rim that is on screen and clear of that column and of
 * the editor's toolbar along the bottom: east, then west, south, north.
 *
 * Dependency-free so `node --test` runs it (rimHandle.test.mts).
 */

export type XY = { x: number; y: number };

/** The right-hand strip the map's control column occupies (18 px inset + 44 px column + slack). */
export const CONTROL_LANE = 80;
/** The bottom strip the editor's toolbar occupies. */
export const TOOLBAR_LANE = 110;
/** Room a handle needs from the other edges. */
const EDGE = 28;

const SIDES: XY[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

/** rimDirection is the unit direction from the centre to the handle. */
export function rimDirection(centre: XY, radiusPx: number, width: number, height: number): XY {
  const clear = (d: XY) => {
    const x = centre.x + d.x * radiusPx;
    const y = centre.y + d.y * radiusPx;
    return x >= EDGE && x <= width - CONTROL_LANE && y >= EDGE && y <= height - TOOLBAR_LANE;
  };
  return SIDES.find(clear) ?? SIDES[0]!;
}
