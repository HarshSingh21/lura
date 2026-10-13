/**
 * releaseDelta is how far a finger travelled in a gesture, as of its release.
 *
 * PanResponder's dx/dy add up the moves it was told about. A browser does not
 * report a touch's first few pixels of movement (Chrome holds touchmove back
 * inside a ~15 px slop region, so a short drag delivers no move at all), and
 * the release itself carries the finger's last position but is not counted.
 * So a short drag — a small circle's radius, a fence nudged a few metres — read
 * as a tap. When the moves account for less than the release shows, the
 * release's own position wins.
 */
export type Delta = { dx: number; dy: number };
export type PagePoint = { pageX?: number; pageY?: number };

export function releaseDelta(moves: Delta, start: PagePoint | null, end: PagePoint | null): Delta {
  if (!start || !end) return moves;
  const { pageX: x0, pageY: y0 } = start;
  const { pageX: x1, pageY: y1 } = end;
  if (![x0, y0, x1, y1].every((v) => typeof v === 'number' && Number.isFinite(v))) return moves;
  const ex = (x1 as number) - (x0 as number);
  const ey = (y1 as number) - (y0 as number);
  // The moves are right whenever they saw at least as much travel as the release.
  return Math.hypot(ex, ey) > Math.hypot(moves.dx, moves.dy) ? { dx: ex, dy: ey } : moves;
}
