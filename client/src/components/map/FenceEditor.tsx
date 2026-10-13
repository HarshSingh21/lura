import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type GestureResponderHandlers,
  type PanResponderGestureState,
  type PointerEvent,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import type { Point } from '@/api/types';
import { Button } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, shadow, size } from '@/theme/tokens';
import { TOUCH_TARGET, useTouchTargets } from '@/theme/touch';

import { absoluteFill } from './fill';
import { releaseDelta, type PagePoint } from './releaseDelta';
import { rimDirection } from './rimHandle';
import {
  CLOSE_PX,
  addCorner,
  circlePreview,
  closePolygon as closeRing,
  drawCircle,
  drawFreehand,
  moveCorner,
  moved,
  plus,
  removeCorner as dropCorner,
  resizeCircle,
  settleEdit,
  tapPolygon,
  translateFence,
  undoPolygon,
} from './fenceOps';
import {
  boundingRadiusM,
  circleRingXY,
  clampRadius,
  distanceXY,
  formatMetres,
  polygonCentroid,
  polygonSelfIntersects,
  scanlineSpans,
  type Span,
  type XY,
} from './geometry';
import { metresPerPixel, project, unproject, type Viewport } from './projection';
import type { FenceEditState, FenceGeometry } from './types';

/**
 * The geofence editor: draw, move, resize and reshape a fence by hand.
 *
 * It is a React overlay in screen space rather than a feature of any one map
 * library, for the same reason the marker pills are: there are five renderers
 * (MapLibre web and native, Mappls web and native, the canvas fallback) and one
 * editor that projects through `projection.ts` behaves identically over all of
 * them, including airgap mode.
 *
 * Gestures are PanResponder — the project has no gesture library, and
 * PanResponder works on web and native alike. The map must keep panning while a
 * fence is being edited, so the overlay is `box-none` and only the parts of the
 * fence a finger can grab take touches:
 *
 *   - the fence body, as a stack of thin strips that follows the outline exactly
 *     (geometry.ts scanlineSpans) — drag to move the whole fence;
 *   - handles, 32 px targets (44 px under a finger, theme/touch) around a small visual dot — drag to resize a
 *     circle or reshape a polygon, tap a midpoint "+" to add a corner,
 *     long-press (or right-click) a corner to remove it — a long-press arms
 *     the removal and releasing in place does it, so a drag that starts slowly
 *     still moves the corner instead of deleting it.
 *
 * Draw modes capture the whole surface instead: every touch there is drawing.
 *
 * The editor is controlled. It reports geometry through `onGeometry(g, false)`
 * while a gesture runs and `onGeometry(g, true)` when it ends — that is the
 * caller's cue to persist. A polygon being drawn keeps its corners in the
 * caller's state (`vertices`), so undo and "Done" are plain state changes. An
 * invalid result (crossing edges, too small) is never reported as done: the
 * editor explains why and snaps back.
 */

export type FenceEditorProps = {
  state: FenceEditState;
  view: Viewport;
  onGeometry: (geometry: FenceGeometry, done: boolean) => void;
  dark?: boolean;
};

/** Target size for every handle under a mouse. */
const HANDLE = 32;
/** ... and under a finger (theme/touch): the 44 px guideline. */
const TOUCH_HANDLE = TOUCH_TARGET;
/** Height of a body hit strip. Smaller hugs the outline better; larger is fewer views. */
const ROW = 8;
const LONG_PRESS_MS = 550;

export function FenceEditor({ state, view, onGeometry, dark }: FenceEditorProps) {
  const ready = view.width > 0 && view.height > 0;
  if (!ready) return null;
  if (state.mode === 'edit') {
    return <EditLayer state={state} view={view} onGeometry={onGeometry} dark={dark} />;
  }
  return <DrawLayer state={state} view={view} onGeometry={onGeometry} dark={dark} />;
}

// ---------------------------------------------------------------- shared

type DragHandlers = {
  onStart?: (event: GestureResponderEvent) => void;
  onMove?: (gesture: PanResponderGestureState) => void;
  onEnd?: (gesture: PanResponderGestureState, cancelled: boolean) => void;
};

/**
 * useDrag wraps PanResponder with handlers that may change on every render.
 *
 * A PanResponder is created once, but the geometry it edits is new on every
 * frame; reading the handlers through a ref keeps the responder stable (so a
 * re-render mid-drag does not drop the gesture) without stale closures.
 */
function useDrag(handlers: DragHandlers): GestureResponderHandlers {
  const ref = useRef(handlers);
  useLayoutEffect(() => {
    ref.current = handlers;
  });
  // Where the finger went down, so a release can say how far it really went
  // (releaseDelta: a short touch drag reports no moves at all).
  const startAt = useRef<PagePoint | null>(null);
  return useMemo(() => {
    const ended = (event: GestureResponderEvent, gesture: PanResponderGestureState): PanResponderGestureState => {
      const { dx, dy } = releaseDelta(gesture, startAt.current, pageOf(event));
      startAt.current = null;
      return dx === gesture.dx && dy === gesture.dy ? gesture : { ...gesture, dx, dy };
    };
    return (
      // The refs are read inside gesture callbacks, which never run during render.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        // Once a fence is grabbed the map must not steal the gesture back.
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (event) => {
          startAt.current = pageOf(event);
          ref.current.onStart?.(event);
        },
        onPanResponderMove: (_event, gesture) => ref.current.onMove?.(gesture),
        onPanResponderRelease: (event, gesture) => ref.current.onEnd?.(ended(event, gesture), false),
        onPanResponderTerminate: (event, gesture) => ref.current.onEnd?.(ended(event, gesture), true),
      }).panHandlers
    );
  }, []);
}

/** pageOf is where a responder event's touch (or pointer) is on the page. */
function pageOf(event: GestureResponderEvent): PagePoint | null {
  const n = event?.nativeEvent as (GestureResponderEvent['nativeEvent'] & { changedTouches?: PagePoint[] }) | undefined;
  if (!n) return null;
  const touch = n.changedTouches?.[0];
  return typeof n.pageX === 'number' ? { pageX: n.pageX, pageY: n.pageY } : touch ? { pageX: touch.pageX, pageY: touch.pageY } : null;
}

/** useHint shows one short message at a time and clears it after a moment. */
function useHint() {
  const [hint, setHint] = useState<{ text: string; seq: number } | null>(null);
  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), 2600);
    return () => clearTimeout(timer);
  }, [hint]);
  return {
    hint: hint?.text ?? null,
    show: (text: string) => setHint((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 })),
  };
}

function strokeFor(invalid: boolean, dark?: boolean) {
  if (invalid) return palette.danger;
  return dark ? palette.accentBright : palette.accent;
}

function ringPath(points: XY[], closed: boolean): string {
  if (points.length === 0) return '';
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  return closed ? `${d} Z` : d;
}

function onScreen(p: XY, view: Viewport, margin = HANDLE): boolean {
  return p.x > -margin && p.y > -margin && p.x < view.width + margin && p.y < view.height + margin;
}

// ---------------------------------------------------------------- draw modes

type DrawState = Exclude<FenceEditState, { mode: 'edit' }>;

function DrawLayer({
  state,
  view,
  onGeometry,
  dark,
}: {
  state: DrawState;
  view: Viewport;
  onGeometry: FenceEditorProps['onGeometry'];
  dark?: boolean;
}) {
  const { hint, show } = useHint();
  const start = useRef<XY | null>(null);
  const sketchRef = useRef<XY[]>([]);
  const [sketch, setSketch] = useState<XY[] | null>(null);
  const [circle, setCircle] = useState<{ center: Point; radiusM: number; edge: XY } | null>(null);
  const [hover, setHover] = useState<XY | null>(null);

  const vertices = state.mode === 'draw-polygon' ? state.vertices : [];
  const toScreen = (p: Point) => project(p, view);
  const toGround = (p: XY) => unproject(p.x, p.y, view);

  const closePolygon = () => {
    const closed = closeRing(vertices);
    if ('problem' in closed) show(closed.problem);
    else onGeometry({ shape: 'polygon', polygon: closed.polygon }, true);
  };

  const addVertex = (xy: XY) => {
    const tap = tapPolygon(vertices, xy, view);
    if (tap.kind === 'refuse') show(tap.problem);
    else onGeometry({ shape: 'polygon', polygon: tap.polygon }, tap.kind === 'close');
  };

  const handlers = useDrag({
    onStart: (event) => {
      const xy = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
      start.current = xy;
      if (state.mode === 'draw-circle') {
        setCircle({ center: toGround(xy), radiusM: 0, edge: xy });
      } else if (state.mode === 'draw-freehand') {
        sketchRef.current = [xy];
        setSketch([xy]);
      }
    },
    onMove: (gesture) => {
      const origin = start.current;
      if (!origin) return;
      const pointer = plus(origin, gesture);
      if (state.mode === 'draw-circle') {
        const { center, radiusM } = circlePreview(origin, gesture, view);
        setCircle({ center, radiusM, edge: pointer });
        onGeometry({ shape: 'circle', center, radiusM: clampRadius(radiusM) }, false);
      } else if (state.mode === 'draw-freehand') {
        const pts = sketchRef.current;
        if (distanceXY(pts[pts.length - 1]!, pointer) >= 3) {
          pts.push(pointer);
          setSketch(pts.slice());
        }
      } else {
        setHover(pointer);
      }
    },
    onEnd: (gesture, cancelled) => {
      const origin = start.current;
      start.current = null;
      if (!origin) return;
      if (state.mode === 'draw-circle') {
        setCircle(null);
        if (cancelled) return;
        // A tap drops a sensible default; a drag sets the radius it drew.
        onGeometry(drawCircle(origin, gesture, view), true);
      } else if (state.mode === 'draw-freehand') {
        const pts = sketchRef.current;
        sketchRef.current = [];
        setSketch(null);
        if (cancelled) return;
        const drawn = drawFreehand(pts, view);
        if ('problem' in drawn) show(drawn.problem);
        else onGeometry({ shape: 'polygon', polygon: drawn.polygon }, true);
      } else if (!cancelled) {
        if (moved(gesture)) {
          show('Tap to add corners; use the zoom buttons to change the view');
          return;
        }
        addVertex(origin);
      }
    },
  });

  // Hover is a mouse affordance: the rubber-band edge from the last corner to
  // the pointer shows where the next tap will land.
  const hoverProps =
    Platform.OS === 'web' && state.mode === 'draw-polygon'
      ? {
          onPointerMove: (e: PointerEvent) => setHover({ x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY }),
          onPointerLeave: () => setHover(null),
        }
      : {};

  const stroke = strokeFor(false, dark);
  const fill = withAlpha(stroke, 0.16);
  const screenVertices = vertices.map(toScreen);
  const nearFirst =
    hover !== null && screenVertices.length >= 3 && distanceXY(hover, screenVertices[0]!) <= CLOSE_PX;

  let visual: ReactNode = null;
  let label: { at: XY; text: string } | null = null;
  if (state.mode === 'draw-circle' && circle) {
    const c = toScreen(circle.center);
    const r = circle.radiusM / metresPerPixel(circle.center.lat, view.zoom);
    visual = (
      <>
        <Circle cx={c.x} cy={c.y} r={Math.max(r, 0)} fill={fill} stroke={stroke} strokeWidth={2} />
        <Line x1={c.x} y1={c.y} x2={circle.edge.x} y2={circle.edge.y} stroke={stroke} strokeWidth={1.5} strokeDasharray="4 4" />
        <Circle cx={c.x} cy={c.y} r={4} fill={stroke} />
      </>
    );
    if (circle.radiusM > 0) label = { at: circle.edge, text: formatMetres(clampRadius(circle.radiusM)) };
  } else if (state.mode === 'draw-freehand' && sketch && sketch.length > 1) {
    visual = (
      <>
        <Path d={ringPath(sketch, true)} fill={fill} stroke="none" />
        <Path d={ringPath(sketch, false)} fill="none" stroke={stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />
      </>
    );
  } else if (state.mode === 'draw-polygon' && screenVertices.length > 0) {
    const last = screenVertices[screenVertices.length - 1]!;
    visual = (
      <>
        {screenVertices.length >= 3 ? <Path d={ringPath(screenVertices, true)} fill={fill} stroke="none" /> : null}
        <Path d={ringPath(screenVertices, false)} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
        {hover ? (
          <Line
            x1={last.x}
            y1={last.y}
            x2={nearFirst ? screenVertices[0]!.x : hover.x}
            y2={nearFirst ? screenVertices[0]!.y : hover.y}
            stroke={stroke}
            strokeWidth={1.5}
            strokeDasharray="5 5"
          />
        ) : null}
        {screenVertices.map((p, i) => (
          <Circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={i === 0 && screenVertices.length >= 3 ? (nearFirst ? 10 : 8) : 5}
            fill={i === 0 && screenVertices.length >= 3 ? withAlpha(stroke, nearFirst ? 0.5 : 0.25) : '#ffffff'}
            stroke={stroke}
            strokeWidth={2}
          />
        ))}
      </>
    );
  }

  const instructions =
    state.mode === 'draw-circle'
      ? 'Press the centre, drag out the radius · tap for 100 m'
      : state.mode === 'draw-freehand'
        ? 'Press and draw around the place, then release.'
        : vertices.length === 0
          ? 'Tap the map to place the first corner.'
          : vertices.length < 3
            ? `Tap to add corners · ${vertices.length} so far`
            : `${vertices.length} corners · tap the first corner or Done to close`;

  return (
    <View style={styles.layer} pointerEvents="box-none">
      <View style={[styles.surface, styles.drawCursor]} {...handlers} {...hoverProps} accessibilityLabel="Drawing surface">
        <View style={absoluteFill} pointerEvents="none">
          <Svg width={view.width} height={view.height}>
            {visual}
          </Svg>
          {label ? <MetreLabel at={label.at} text={label.text} /> : null}
        </View>
      </View>

      <Toolbar>
        <Txt variant="small" color={color.textBody} style={styles.toolbarText}>
          {instructions}
        </Txt>
        {state.mode === 'draw-polygon' ? (
          <View style={styles.toolbarActions}>
            <Button
              label="Undo"
              variant="secondary"
              small
              disabled={vertices.length === 0}
              onPress={() => onGeometry({ shape: 'polygon', polygon: undoPolygon(vertices) }, false)}
            />
            <Button label="Done" small disabled={vertices.length < 3} onPress={closePolygon} />
          </View>
        ) : null}
      </Toolbar>
      {hint ? <Hint text={hint} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------- edit mode

type EditState = Extract<FenceEditState, { mode: 'edit' }>;

function geometryOf(state: EditState): FenceGeometry {
  return state.shape === 'circle'
    ? { shape: 'circle', center: state.center, radiusM: state.radiusM }
    : { shape: 'polygon', polygon: state.polygon };
}

function EditLayer({
  state,
  view,
  onGeometry,
  dark,
}: {
  state: EditState;
  view: Viewport;
  onGeometry: FenceEditorProps['onGeometry'];
  dark?: boolean;
}) {
  const { hint, show } = useHint();
  const touch = useTouchTargets();
  const handle = touch ? TOUCH_HANDLE : HANDLE;
  // While a gesture runs the editor draws its own copy of the geometry, so the
  // drag stays smooth even if the caller only re-renders on `done`.
  const [live, setLive] = useState<FenceGeometry | null>(null);
  const shown = live ?? geometryOf(state);
  // The geometry at the start of the running gesture, if any (see `targets`).
  const [frozen, setFrozen] = useState<FenceGeometry | null>(null);
  const toScreen = (p: Point) => project(p, view);

  // ---- gesture bookkeeping shared by every handle
  // `armed`: a corner held still for LONG_PRESS_MS is marked for removal, which
  // happens on release. Moving after that is still a drag: a slow device that
  // delivers the first movement late must not delete the corner being dragged.
  const gesture = useRef<{ from: FenceGeometry; anchor: XY; armed: boolean } | null>(null);
  const [armedCorner, setArmedCorner] = useState<number | null>(null);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const timer = longPress;
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function clearLongPress() {
    if (longPress.current) clearTimeout(longPress.current);
    longPress.current = null;
  }

  function begin(anchor: XY) {
    gesture.current = { from: shown, anchor, armed: false };
    setFrozen(shown);
  }

  function update(next: FenceGeometry) {
    setLive(next);
    onGeometry(next, false);
  }

  /** finish reports a valid result as done, or explains and snaps back. */
  function finish(next: FenceGeometry | null, cancelled: boolean) {
    const from = gesture.current?.from;
    gesture.current = null;
    clearLongPress();
    setLive(null);
    setFrozen(null);
    if (!from) return;
    const outcome = settleEdit(from, next, cancelled);
    if (outcome.problem) show(outcome.problem);
    onGeometry(outcome.geometry, outcome.done);
  }

  // ---- body: move the whole fence, in screen space so the shape stays the
  // shape you see (a degree of longitude is not the same width at every latitude)
  const translate = (from: FenceGeometry, g: PanResponderGestureState): FenceGeometry => translateFence(from, g, view);
  const body = useDrag({
    onStart: () => begin({ x: 0, y: 0 }),
    onMove: (g) => {
      const from = gesture.current?.from;
      if (from && moved(g)) update(translate(from, g));
    },
    onEnd: (g, cancelled) => {
      const from = gesture.current?.from;
      finish(from && moved(g) ? translate(from, g) : null, cancelled);
    },
  });

  // ---- circle edge: resize
  const radiusFrom = (from: FenceGeometry, g: PanResponderGestureState): FenceGeometry | null => {
    if (from.shape !== 'circle' || !gesture.current) return null;
    return resizeCircle(from, gesture.current.anchor, g, view);
  };
  const edge = useDrag({
    onStart: () => {
      if (shown.shape === 'circle') begin(edgePoint(shown.center, shown.radiusM, view));
    },
    onMove: (g) => {
      const next = gesture.current ? radiusFrom(gesture.current.from, g) : null;
      if (next) update(next);
    },
    onEnd: (g, cancelled) => {
      const next = gesture.current && moved(g) ? radiusFrom(gesture.current.from, g) : null;
      finish(next, cancelled);
    },
  });

  const invalid = live?.shape === 'polygon' ? polygonSelfIntersects(live.polygon) : false;
  const stroke = strokeFor(invalid, dark);
  const fill = withAlpha(stroke, 0.16);
  // Touch targets are laid out from the geometry as it was when the gesture
  // began. A target that moved or unmounted under the finger would end the
  // gesture on native, so they hold still and only the drawing follows.
  const targets = frozen ?? shown;

  if (shown.shape === 'circle') {
    const c = toScreen(shown.center);
    const rPx = shown.radiusM / metresPerPixel(shown.center.lat, view.zoom);
    const t = targets.shape === 'circle' ? targets : shown;
    const tc = toScreen(t.center);
    const te = edgePoint(t.center, t.radiusM, view);
    // The drawn handle keeps the side the gesture started on, so it cannot hop mid-drag.
    const side = rimDirection(tc, t.radiusM / metresPerPixel(t.center.lat, view.zoom), view.width, view.height);
    const e = { x: c.x + side.x * rPx, y: c.y + side.y * rPx };
    const spans = scanlineSpans(
      circleRingXY(tc, t.radiusM / metresPerPixel(t.center.lat, view.zoom)),
      ROW,
      view.height,
      view.width,
    );
    return (
      <View style={styles.layer} pointerEvents="box-none">
        <View style={absoluteFill} pointerEvents="none">
          <Svg width={view.width} height={view.height}>
            <Circle cx={c.x} cy={c.y} r={rPx} fill={fill} stroke={stroke} strokeWidth={2} />
            <Line x1={c.x} y1={c.y} x2={e.x} y2={e.y} stroke={stroke} strokeWidth={1.5} strokeDasharray="4 4" />
            <GripGlyph at={c} stroke={stroke} />
            <Circle cx={e.x} cy={e.y} r={9} fill="#ffffff" stroke={stroke} strokeWidth={2.5} />
          </Svg>
          <MetreLabel at={{ x: (c.x + e.x) / 2, y: (c.y + e.y) / 2 }} text={formatMetres(shown.radiusM)} below />
        </View>
        <BodySpans spans={spans} handlers={body} />
        <Target at={tc} handlers={body} label="Move fence" size={handle} />
        {onScreen(te, view) ? <Target at={te} handlers={edge} label="Resize fence" size={handle} /> : null}
        <Toolbar>
          <Txt variant="small" color={color.textBody} style={styles.toolbarText}>
            Drag the circle to move it · drag the edge handle to resize
          </Txt>
        </Toolbar>
        {hint ? <Hint text={hint} /> : null}
      </View>
    );
  }

  const polygon = shown.polygon;
  const pts = polygon.map(toScreen);
  const centroid = toScreen(polygonCentroid(polygon));
  const targetRing = targets.shape === 'polygon' ? targets.polygon : polygon;
  const targetPts = targetRing.map(toScreen);
  const spans = scanlineSpans(targetPts, ROW, view.height, view.width);
  const targetCentroid = toScreen(polygonCentroid(targetRing));
  // Midpoint "+" handles go only on edges long enough on screen to hold one
  // between two corners without the three targets overlapping (under a finger,
  // not overlapping at all: half a target either side of the midpoint).
  const roomFor = touch ? handle * 2 : HANDLE * 1.6;
  const mids = (ring: XY[]) =>
    ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length]!;
      return { at: { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, roomy: distanceXY(p, q) >= roomFor };
    });
  const shownMids = frozen ? [] : mids(pts);
  const targetMids = mids(targetPts);

  return (
    <View style={styles.layer} pointerEvents="box-none">
      <View style={absoluteFill} pointerEvents="none">
        <Svg width={view.width} height={view.height}>
          <Path d={ringPath(pts, true)} fill={fill} stroke={stroke} strokeWidth={2} strokeLinejoin="round" />
          {shownMids.map((m, i) =>
            m.roomy && onScreen(m.at, view) ? <PlusGlyph key={`pm${i}`} at={m.at} stroke={stroke} /> : null,
          )}
          {pts.map((p, i) =>
            onScreen(p, view) ? (
              armedCorner === i ? (
                <Circle key={`pv${i}`} cx={p.x} cy={p.y} r={10} fill={palette.danger} stroke="#ffffff" strokeWidth={2.5} />
              ) : (
                <Circle key={`pv${i}`} cx={p.x} cy={p.y} r={7} fill="#ffffff" stroke={stroke} strokeWidth={2.5} />
              )
            ) : null,
          )}
          <GripGlyph at={centroid} stroke={stroke} />
        </Svg>
      </View>
      <BodySpans spans={spans} handlers={body} />
      <Target at={targetCentroid} handlers={body} label="Move fence" size={handle} />
      {targetMids.map((m, i) =>
        m.roomy && onScreen(m.at, view) ? (
          <DragTarget
            key={`m${i}`}
            at={m.at}
            size={handle}
            label="Add a corner"
            onStart={() => begin(m.at)}
            onMove={(g) => {
              const from = gesture.current?.from;
              if (from?.shape !== 'polygon' || !moved(g)) return;
              const added = addCorner(from.polygon, i, m.at, g, view);
              if ('polygon' in added) update({ shape: 'polygon', polygon: added.polygon });
            }}
            onEnd={(g, cancelled) => {
              const from = gesture.current?.from;
              if (from?.shape !== 'polygon') return finish(null, true);
              // A tap inserts at the midpoint; a drag inserts where it was dragged.
              const added = addCorner(from.polygon, i, m.at, g, view);
              if ('problem' in added) {
                show(added.problem);
                return finish(null, true);
              }
              finish({ shape: 'polygon', polygon: added.polygon }, cancelled);
            }}
          />
        ) : null,
      )}
      {targetPts.map((p, i) =>
        onScreen(p, view) ? (
          <DragTarget
            key={`v${i}`}
            at={p}
            size={handle}
            label="Fence corner"
            onStart={() => {
              begin(p);
              clearLongPress();
              longPress.current = setTimeout(() => {
                const current = gesture.current;
                if (!current || current.from.shape !== 'polygon') return;
                if (current.from.polygon.length <= 3) {
                  show('A shape needs at least three corners');
                  return;
                }
                current.armed = true;
                setArmedCorner(i);
                show('Release to remove this corner · drag to move it instead');
              }, LONG_PRESS_MS);
            }}
            onMove={(g) => {
              const current = gesture.current;
              if (!current || current.from.shape !== 'polygon' || !moved(g)) return;
              clearLongPress();
              if (current.armed) {
                current.armed = false;
                setArmedCorner(null);
              }
              update({ shape: 'polygon', polygon: moveCorner(current.from.polygon, i, current.anchor, g, view) });
            }}
            onEnd={(g, cancelled) => {
              const current = gesture.current;
              clearLongPress();
              setArmedCorner(null);
              if (!current || current.from.shape !== 'polygon') {
                gesture.current = null;
                setFrozen(null);
                return;
              }
              if (!moved(g)) {
                if (current.armed && !cancelled) return removeCorner(current.from.polygon, i);
                return finish(null, true);
              }
              finish({ shape: 'polygon', polygon: moveCorner(current.from.polygon, i, current.anchor, g, view) }, cancelled);
            }}
            onSecondary={() => {
              begin(p);
              removeCorner(polygon, i);
            }}
          />
        ) : null,
      )}
      <Toolbar>
        {/* The size lives here rather than on the map, where any spot is
            somebody's corner or "+" handle. */}
        <View style={styles.toolbarText}>
          <Mono size={size.monoSm} medium color={invalid ? palette.dangerInk : color.textStrong}>
            {polygon.length} corners · up to {formatMetres(boundingRadiusM(polygon))} from the centre
          </Mono>
          <Txt variant="small" color={color.textBody}>
            Drag the shape to move it · drag a corner to reshape · tap + to add a corner · long-press
            {Platform.OS === 'web' ? ' or right-click' : ''} a corner to remove it
          </Txt>
        </View>
      </Toolbar>
      {hint ? <Hint text={hint} /> : null}
    </View>
  );

  function removeCorner(ring: Point[], index: number) {
    const removed = dropCorner(ring, index);
    if ('problem' in removed) {
      show(removed.problem);
      finish(null, true);
      return;
    }
    finish({ shape: 'polygon', polygon: removed.polygon }, false);
  }
}

/** edgePoint is where the resize handle sits on the rim: east, unless that is under the map's controls (rimHandle.ts). */
function edgePoint(center: Point, radiusM: number, view: Viewport): XY {
  const c = project(center, view);
  const r = radiusM / metresPerPixel(center.lat, view.zoom);
  const d = rimDirection(c, r, view.width, view.height);
  return { x: c.x + d.x * r, y: c.y + d.y * r };
}

// ---------------------------------------------------------------- pieces

function BodySpans({ spans, handlers }: { spans: Span[]; handlers: GestureResponderHandlers }) {
  return (
    <>
      {spans.map((s, i) => (
        <View
          key={i}
          {...handlers}
          style={[styles.span, { left: s.x0, top: s.y, width: s.x1 - s.x0, height: s.height }]}
        />
      ))}
    </>
  );
}

/** Target is an invisible handle-sized touch target; the visual is drawn in the SVG. */
function Target({ at, handlers, label, size: s = HANDLE }: { at: XY; handlers: GestureResponderHandlers; label: string; size?: number }) {
  return (
    <View
      {...handlers}
      accessibilityLabel={label}
      style={[styles.handle, { left: at.x - s / 2, top: at.y - s / 2, width: s, height: s }]}
    />
  );
}

/** DragTarget is a Target with its own responder, for per-corner handles. */
function DragTarget({
  at,
  label,
  onSecondary,
  size: s = HANDLE,
  ...drag
}: DragHandlers & { at: XY; label: string; onSecondary?: () => void; size?: number }) {
  const handlers = useDrag(drag);
  // Right-click is the desktop spelling of long-press. React Native's types do
  // not know the DOM's contextmenu event, so it is attached only on web.
  const webProps =
    Platform.OS === 'web' && onSecondary
      ? {
          onContextMenu: (event: { preventDefault: () => void }) => {
            event.preventDefault();
            onSecondary();
          },
        }
      : {};
  return (
    <View
      {...handlers}
      {...(webProps as object)}
      accessibilityLabel={label}
      style={[styles.handle, { left: at.x - s / 2, top: at.y - s / 2, width: s, height: s }]}
    />
  );
}

/** GripGlyph is the four-way "move" mark at the centre of a fence. */
function GripGlyph({ at, stroke }: { at: XY; stroke: string }) {
  return (
    <>
      <Circle cx={at.x} cy={at.y} r={12} fill="#ffffff" stroke={stroke} strokeWidth={2} />
      <Line x1={at.x - 6} y1={at.y} x2={at.x + 6} y2={at.y} stroke={stroke} strokeWidth={2} strokeLinecap="round" />
      <Line x1={at.x} y1={at.y - 6} x2={at.x} y2={at.y + 6} stroke={stroke} strokeWidth={2} strokeLinecap="round" />
    </>
  );
}

/** PlusGlyph marks an edge midpoint where a corner can be added. */
function PlusGlyph({ at, stroke }: { at: XY; stroke: string }) {
  return (
    <>
      <Circle cx={at.x} cy={at.y} r={8} fill="rgba(255,255,255,0.92)" stroke={stroke} strokeWidth={1.5} />
      <Line x1={at.x - 4} y1={at.y} x2={at.x + 4} y2={at.y} stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
      <Line x1={at.x} y1={at.y - 4} x2={at.x} y2={at.y + 4} stroke={stroke} strokeWidth={1.5} strokeLinecap="round" />
    </>
  );
}

function MetreLabel({ at, text, below }: { at: XY; text: string; below?: boolean }) {
  return (
    <View
      pointerEvents="none"
      testID="fence-metre-label"
      style={[styles.metre, { left: at.x, top: below ? at.y + 8 : at.y - 30 }]}
    >
      <View style={styles.metreInner}>
        <Mono size={size.monoSm} medium color={color.textStrong}>
          {text}
        </Mono>
      </View>
    </View>
  );
}

function Toolbar({ children }: { children: ReactNode }) {
  return (
    <View style={styles.toolbarWrap} pointerEvents="box-none">
      <View style={styles.toolbar}>{children}</View>
    </View>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <View style={styles.hintWrap} pointerEvents="none">
      <View style={styles.hint} accessibilityLiveRegion="polite">
        <Txt variant="small" color={palette.dangerInk}>
          {text}
        </Txt>
      </View>
    </View>
  );
}

/** withAlpha turns a #rrggbb token into an rgba string. */
function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * A drag that starts on the editor must not also select the page's text, which
 * is what a browser does with a mouse-down-and-move by default. `userSelect` is
 * typed for text only in React Native, but React Native Web honours it on views.
 */
const noSelect = (Platform.OS === 'web' ? { userSelect: 'none' } : {}) as ViewStyle;

const styles = StyleSheet.create({
  layer: { ...absoluteFill, ...noSelect },
  surface: absoluteFill,
  drawCursor: { cursor: 'pointer' },
  span: { position: 'absolute', cursor: 'pointer' },

  handle: {
    position: 'absolute',
    width: HANDLE,
    height: HANDLE,
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },

  metre: {
    position: 'absolute',
    width: 160,
    alignItems: 'center',
    transform: [{ translateX: -80 }],
  },
  metreInner: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: 8,
    paddingVertical: 3,
    ...shadow('float'),
  },

  toolbarWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 20,
    alignItems: 'center',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 10,
    maxWidth: 560,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: 9,
    paddingHorizontal: 14,
    ...shadow('card'),
  },
  toolbarText: { flexShrink: 1, gap: 3 },
  toolbarActions: { flexDirection: 'row', gap: 8 },

  hintWrap: { position: 'absolute', left: 12, right: 12, top: 72, alignItems: 'center' },
  hint: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: palette.danger,
    borderRadius: radius.md,
    paddingHorizontal: 12,
    paddingVertical: 7,
    ...shadow('float'),
  },
});
