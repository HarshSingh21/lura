/**
 * Fence-label decluttering.
 *
 * Every fence carries a name pill above it. Thirty shops on one street at
 * city zoom would stack thirty pills into an unreadable smear, so labels are
 * placed greedily, most important first, and a label that would overlap one
 * already placed is left out until the map is zoomed in far enough for it to
 * fit. The fence itself is still drawn (and still tappable); only its name waits.
 *
 * Importance: the selected fence always wins, then the larger fence on screen
 * (a district reads before the shop inside it), then the original order, so the
 * result is stable from frame to frame while the map pans.
 *
 * Dependency-free so `node --test` runs it (labels.test.mts).
 */

export type LabelBox = {
  id: string;
  /** Horizontal centre of the pill, in screen pixels. */
  cx: number;
  /** Top edge of the pill. */
  top: number;
  width: number;
  height: number;
  selected?: boolean;
  /** On-screen size of the fence (px), for importance. */
  extent: number;
};

/** Pills closer than this are treated as touching: a 1 px gap still reads as one smear. */
const GAP = 3;

/** estimateLabelWidth approximates a pill's width without measuring text (11 px semibold sans). */
export function estimateLabelWidth(name: string, badge?: string): number {
  const text = name.length * 6.6 + 20;
  const extra = badge ? badge.length * 5.8 + 16 : 0;
  return Math.min(180, Math.ceil(text + extra));
}

export function placeLabels(boxes: LabelBox[]): Set<string> {
  const order = boxes
    .map((b, i) => ({ b, i }))
    .sort((p, q) => Number(!!q.b.selected) - Number(!!p.b.selected) || q.b.extent - p.b.extent || p.i - q.i);
  const placed: LabelBox[] = [];
  const shown = new Set<string>();
  for (const { b } of order) {
    const l = b.cx - b.width / 2;
    const clash = placed.some((o) => {
      const ol = o.cx - o.width / 2;
      return l < ol + o.width + GAP && ol < l + b.width + GAP && b.top < o.top + o.height + GAP && o.top < b.top + b.height + GAP;
    });
    if (clash && !b.selected) continue;
    placed.push(b);
    shown.add(b.id);
  }
  return shown;
}
