import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Defs, G, Line, Path, Polygon, RadialGradient, Stop } from 'react-native-svg';

import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, shadow, size } from '@/theme/tokens';

import { Dot } from '@/components/ui/primitives';
import { absoluteFill } from './fill';
import { pointInPolygon } from './geometry';
import { circlePolygon, metresPerPixel, project, type Viewport } from './projection';
import type { MapFence, MapMarker, MapTone, MapTrack } from './types';

/**
 * Screen-space overlays shared by every map renderer.
 *
 * Fences and markers are drawn as React Native views rather than map layers, for
 * one reason that matters: the mock's marker is a pill label above a pulsing dot,
 * and reproducing that as a MapLibre symbol layer would mean maintaining a
 * separate design (and a separate sprite) per platform. Positioning them from the
 * same Web Mercator projection the basemap uses keeps them pinned as the map moves.
 */

export function toneColor(tone: MapTone | undefined, dark: boolean): string {
  switch (tone) {
    case 'amber':
      return palette.amber;
    case 'neutral':
      return dark ? color.inkPanelText : color.neutralDot;
    default:
      return dark ? palette.accentBright : palette.accent;
  }
}

/** hasPolygon is the one test every renderer uses to choose polygon over circle. */
export function hasPolygon(fence: MapFence): fence is MapFence & { polygon: MapFence['center'][] } {
  return Array.isArray(fence.polygon) && fence.polygon.length >= 3;
}

/**
 * polygonFenceAt is the polygon fence a tap at `point` lands on, for renderers
 * that draw polygons in screen space and so have no tap target for their body
 * (a circle's body is its own Pressable). Judged planar in lon/lat, as drawn;
 * the last one listed is drawn on top, so it wins.
 */
export function polygonFenceAt(fences: MapFence[], point: MapFence['center']): MapFence | undefined {
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const fence = fences[i]!;
    if (hasPolygon(fence) && pointInPolygon(point, fence.polygon)) return fence;
  }
  return undefined;
}

/** fenceRing is a fence's outline as a closed GeoJSON ring of [lon, lat], polygon or circle. */
export function fenceRing(fence: MapFence): [number, number][] {
  if (!hasPolygon(fence)) return circlePolygon(fence.center, fence.radiusM);
  const ring = fence.polygon.map((p) => [p.lon, p.lat] as [number, number]);
  const first = ring[0];
  if (first) ring.push([first[0], first[1]]); // the wire ring is open; GeoJSON's is closed
  return ring;
}

/**
 * FenceOverlay draws fence outlines (where the renderer does not), their labels,
 * and the tap targets.
 *
 * `glShapes` says the renderer already draws fence geometry as map layers
 * (MapLibre web and native). Circles keep their screen-space body either way —
 * it is also their tap target. Polygons are different: a tap target the size of
 * a polygon's bounding box would swallow map gestures over a whole neighbourhood,
 * so a GL renderer takes polygon taps from its fill layer, and the overlay only
 * adds the label pill (which is tappable everywhere).
 */
export function FenceOverlay({
  fences,
  view,
  dark,
  onPress,
  glShapes,
  darkGround,
}: {
  fences: MapFence[];
  view: Viewport;
  dark?: boolean;
  onPress?: (id: string) => void;
  glShapes?: boolean;
  /** The basemap under the fences is imagery or dark (basemaps.ts onDarkGround). */
  darkGround?: boolean;
}) {
  const mpp = metresPerPixel(view.center.lat, view.zoom);

  return (
    <>
      {fences.map((fence) => {
        if (hasPolygon(fence)) {
          return (
            <PolygonFence
              key={fence.id}
              fence={fence}
              view={view}
              dark={!!dark}
              darkGround={!!darkGround}
              onPress={onPress}
              drawShape={!glShapes}
            />
          );
        }
        const { x, y } = project(fence.center, view);
        const diameter = (fence.radiusM * 2) / mpp;
        // Off-screen fences are skipped rather than rendered at huge offsets: a
        // city's worth of places should not cost a city's worth of views.
        if (
          diameter < 6 ||
          x < -diameter ||
          y < -diameter ||
          x > view.width + diameter ||
          y > view.height + diameter
        ) {
          return null;
        }
        const stroke = toneColor(fence.tone, !!dark);

        return (
          <View key={fence.id} pointerEvents="box-none">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={fence.name ? `Place ${fence.name}` : 'Place'}
              onPress={onPress ? () => onPress(fence.id) : undefined}
              style={[
                styles.fence,
                {
                  left: x - diameter / 2,
                  top: y - diameter / 2,
                  width: diameter,
                  height: diameter,
                  borderRadius: diameter / 2,
                  backgroundColor: withOpacity(stroke, darkGround ? 0.2 : fence.tone === 'amber' ? 0.12 : 0.1),
                  borderColor: withOpacity(stroke, fence.selected || darkGround ? 1 : 0.8),
                  borderWidth: fence.selected ? 3 : 2.5,
                  borderStyle: fence.dashed ? 'dashed' : 'solid',
                },
                darkGround ? styles.fenceHaloDark : styles.fenceHaloLight,
              ]}
            />
            {fence.name ? <FenceLabel fence={fence} left={x} top={y - diameter / 2 - 30} /> : null}
          </View>
        );
      })}
    </>
  );
}

/**
 * PolygonFence draws one polygon fence in screen space: the shape itself when
 * the renderer has no GL layer for it, and a label pill centred on its centroid
 * just above its top edge — where a circle's label sits, and clear of the marker
 * of whoever is standing inside it.
 */
function PolygonFence({
  fence,
  view,
  dark,
  darkGround,
  onPress,
  drawShape,
}: {
  fence: MapFence & { polygon: MapFence['center'][] };
  view: Viewport;
  dark: boolean;
  darkGround: boolean;
  onPress?: (id: string) => void;
  drawShape: boolean;
}) {
  const pts = fence.polygon.map((p) => project(p, view));
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (maxX < 0 || maxY < 0 || minX > view.width || minY > view.height) return null;
  if (w < 4 && h < 4) return null;

  const stroke = toneColor(fence.tone, dark);
  const c = centroid(pts);
  const pad = 5;
  const points = pts.map((p) => `${(p.x - minX + pad).toFixed(1)},${(p.y - minY + pad).toFixed(1)}`).join(' ');

  return (
    <View pointerEvents="box-none" style={absoluteFill}>
      {drawShape ? (
        // A wrapper with pointerEvents="none": the SVG's box must never take a
        // gesture meant for the map underneath it.
        <View pointerEvents="none" style={[styles.polygonBox, { left: minX - pad, top: minY - pad, width: w + pad * 2, height: h + pad * 2 }]}>
          <Svg width={w + pad * 2} height={h + pad * 2}>
            {/* The halo under the outline, as the GL renderers' casing line. */}
            <Polygon
              points={points}
              fill="none"
              stroke={darkGround ? '#06110b' : '#ffffff'}
              strokeOpacity={darkGround ? 0.6 : 0.92}
              strokeWidth={fence.selected ? 7 : 5.5}
              strokeLinejoin="round"
            />
            <Polygon
              points={points}
              fill={stroke}
              fillOpacity={darkGround ? 0.22 : fence.tone === 'amber' ? 0.16 : 0.14}
              stroke={stroke}
              strokeWidth={fence.selected ? 3.5 : 2.5}
              strokeDasharray={fence.dashed ? '6 4' : undefined}
              strokeLinejoin="round"
            />
          </Svg>
        </View>
      ) : null}
      {fence.name ? (
        <FenceLabel fence={fence} left={c.x} top={minY - 30} onPress={onPress ? () => onPress(fence.id) : undefined} />
      ) : null}
    </View>
  );
}

function FenceLabel({
  fence,
  left,
  top,
  onPress,
}: {
  fence: MapFence;
  left: number;
  top: number;
  onPress?: () => void;
}) {
  const inner = (
    <View style={styles.fenceLabelInner}>
      <Txt variant="micro" style={styles.fenceLabelText}>
        {fence.name}
      </Txt>
      {fence.badge ? (
        fence.tone === 'amber' ? (
          <View style={styles.fenceBadgeAmber}>
            <Mono size={size.monoTiny} medium color={palette.amberTag}>
              {fence.badge}
            </Mono>
          </View>
        ) : (
          <Mono size={size.monoXs} color={color.textFaint}>
            {fence.badge}
          </Mono>
        )
      ) : null}
    </View>
  );
  if (!onPress) {
    return (
      <View pointerEvents="none" style={[styles.fenceLabel, { left, top }]}>
        {inner}
      </View>
    );
  }
  return (
    <View pointerEvents="box-none" style={[styles.fenceLabel, { left, top }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={fence.name ? `Place ${fence.name}` : 'Place'} onPress={onPress}>
        {inner}
      </Pressable>
    </View>
  );
}

/** centroid is a polygon's area centroid in screen space (vertex mean if degenerate). */
export function centroid(pts: { x: number; y: number }[]): { x: number; y: number } {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    if (!p || !q) continue;
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-6) {
    const n = Math.max(1, pts.length);
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/**
 * TrackOverlay draws recorded paths in screen space.
 *
 * The MapLibre renderers draw tracks as GL line layers; the canvas and the Mappls
 * renderers use this instead, so a provider only has to supply a basemap and a
 * viewport — not a second implementation of every layer.
 */
export function TrackOverlay({ tracks, view, dark }: { tracks: MapTrack[]; view: Viewport; dark?: boolean }) {
  if (tracks.length === 0 || view.width <= 0 || view.height <= 0) return null;
  return (
    <Svg width={view.width} height={view.height} style={absoluteFill} pointerEvents="none">
      {tracks.map((track) => {
        const pts = track.points.map((p) => project(p, view));
        if (pts.length < 2) return null;
        const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
        return (
          <Path
            key={track.id}
            d={d}
            stroke={toneColor(track.tone, !!dark)}
            strokeWidth={track.width ?? 4}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
            strokeDasharray={track.dotted ? '1 10' : undefined}
          />
        );
      })}
    </Svg>
  );
}

/**
 * MarkerOverlay draws every marker: small waypoint dots as they always were, and
 * live markers as a person moving — trail, accuracy, heading, pulse, ripple and
 * a glide between fixes (LiveMarker below).
 *
 * The trails share one SVG under all markers so that a person's wake never draws
 * over somebody else's dot.
 */
export function MarkerOverlay({
  markers,
  view,
  dark,
}: {
  markers: MapMarker[];
  view: Viewport;
  dark?: boolean;
}) {
  const trails = markers.filter((m) => (m.trail?.length ?? 0) > 1);
  return (
    <>
      {/* The viewport every overlay is projected through, for the end-to-end
          suite (e2e/), which has to turn coordinates into clicks. */}
      <View
        pointerEvents="none"
        testID="lura-map-viewport"
        {...webData({
          lat: view.center.lat,
          lon: view.center.lon,
          zoom: view.zoom,
          width: view.width,
          height: view.height,
        })}
      />
      {trails.length > 0 ? <TrailLayer markers={trails} view={view} dark={!!dark} /> : null}
      {markers.map((marker) => {
        const { x, y } = project(marker.point, view);
        if (x < -120 || y < -120 || x > view.width + 120 || y > view.height + 120) return null;
        const tint = marker.color ?? toneColor(marker.tone, !!dark);

        if (marker.small) {
          return (
            <View
              key={marker.id}
              pointerEvents="none"
              style={[styles.smallMarker, { left: x - 7, top: y - 7, borderColor: tint }]}
            />
          );
        }

        return <LiveMarker key={marker.id} marker={marker} view={view} tint={tint} />;
      })}
    </>
  );
}

/** Below this on-screen diameter an accuracy circle hides under the dot anyway. */
const MIN_ACCURACY_PX = 26;
/** Heading cone reach, px. */
const CONE_PX = 38;
/** One millidegree: the step used to linearise the projection around a marker. */
const STEP_DEG = 0.001;

/**
 * LiveMarker glides between fixes without re-rendering per frame.
 *
 * The marker's geographic position is an `Animated.ValueXY` (x = lon, y = lat)
 * that Animated tweens towards each new fix over `animateMs` — retargeting from
 * wherever it currently is when a fix arrives mid-glide. Screen position is then
 * a linear map of that value, rebuilt from the projection on each render: at the
 * scale of one glide Web Mercator is linear to well under a pixel, so the marker
 * stays pinned to the basemap while the map pans *and* while it moves. React only
 * re-renders when a fix arrives or the viewport changes, never per frame.
 */
function LiveMarker({ marker, view, tint }: { marker: MapMarker; view: Viewport; tint: string }) {
  const { point, animateMs = 0 } = marker;
  const [geo] = useState(() => new Animated.ValueXY({ x: point.lon, y: point.lat }));
  const [ripple] = useState(() => new Animated.Value(1));
  const lastRipple = useRef(marker.rippleKey);

  // ---- glide to each new fix
  useEffect(() => {
    const to = { x: point.lon, y: point.lat };
    if (animateMs <= 0) {
      geo.stopAnimation();
      geo.setValue(to);
      return;
    }
    const glide = Animated.timing(geo, {
      toValue: to,
      duration: animateMs,
      // Constant speed between fixes: easing in and out at every fix reads as a
      // person stopping and starting every two seconds.
      easing: Easing.linear,
      // Positions feed interpolations that are rebuilt on every viewport change,
      // which the native driver cannot follow.
      useNativeDriver: false,
    });
    glide.start();
    return () => glide.stop();
  }, [geo, point.lat, point.lon, animateMs]);

  // ---- one-shot ripple when rippleKey changes (never on mount)
  useEffect(() => {
    const changed = marker.rippleKey !== undefined && marker.rippleKey !== lastRipple.current;
    lastRipple.current = marker.rippleKey;
    if (!changed) return;
    ripple.setValue(0);
    const anim = Animated.timing(ripple, {
      toValue: 1,
      duration: 1400,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    anim.start();
    return () => anim.stop();
  }, [ripple, marker.rippleKey]);

  // Two reference points one step apart give the exact linear map from the
  // animated coordinate to pixels for the current viewport.
  const base = project(point, view);
  const east = project({ lat: point.lat, lon: point.lon + STEP_DEG }, view);
  const north = project({ lat: point.lat + STEP_DEG, lon: point.lon }, view);
  const translateX = geo.x.interpolate({
    inputRange: [point.lon, point.lon + STEP_DEG],
    outputRange: [base.x, east.x],
    extrapolate: 'extend',
  });
  const translateY = geo.y.interpolate({
    inputRange: [point.lat, point.lat + STEP_DEG],
    outputRange: [base.y, north.y],
    extrapolate: 'extend',
  });

  const mpp = metresPerPixel(point.lat, view.zoom);
  const accuracyPx = marker.accuracyM ? (marker.accuracyM * 2) / mpp : 0;
  const showAccuracy = accuracyPx >= MIN_ACCURACY_PX && accuracyPx <= Math.max(view.width, view.height) * 2;
  const heading = marker.headingDeg;
  const gradientId = `lura-cone-${marker.id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

  const rippleScale = ripple.interpolate({ inputRange: [0, 1], outputRange: [1, 7] });
  const rippleOpacity = ripple.interpolate({ inputRange: [0, 0.15, 1], outputRange: [0, 0.65, 0] });

  return (
    <Animated.View
      pointerEvents="none"
      testID={`lura-marker-${marker.id}`}
      {...webData({
        lat: point.lat,
        lon: point.lon,
        label: marker.label ?? '',
        heading: heading !== undefined && Number.isFinite(heading) ? Math.round(heading) : '',
        stale: marker.stale ? 'true' : 'false',
      })}
      style={[styles.anchor, marker.stale ? styles.anchorStale : null, { transform: [{ translateX }, { translateY }] }]}
    >
      {showAccuracy ? (
        <View
          style={[
            styles.accuracy,
            {
              left: -accuracyPx / 2,
              top: -accuracyPx / 2,
              width: accuracyPx,
              height: accuracyPx,
              borderRadius: accuracyPx / 2,
              backgroundColor: withOpacity(tint, 0.12),
              borderColor: withOpacity(tint, 0.35),
            },
          ]}
        />
      ) : null}

      {heading !== undefined && Number.isFinite(heading) ? (
        <View style={[styles.cone, { transform: [{ rotate: `${heading}deg` }] }]}>
          <Svg width={CONE_PX * 2} height={CONE_PX * 2} viewBox={`0 0 ${CONE_PX * 2} ${CONE_PX * 2}`}>
            <Defs>
              <RadialGradient
                id={gradientId}
                cx={CONE_PX}
                cy={CONE_PX}
                r={CONE_PX}
                fx={CONE_PX}
                fy={CONE_PX}
                gradientUnits="userSpaceOnUse"
              >
                <Stop offset="0" stopColor={tint} stopOpacity={0.6} />
                <Stop offset="1" stopColor={tint} stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Path d={conePath(CONE_PX, 32)} fill={`url(#${gradientId})`} />
          </Svg>
        </View>
      ) : null}

      <Animated.View
        style={[styles.ripple, { borderColor: tint, opacity: rippleOpacity, transform: [{ scale: rippleScale }] }]}
      />

      {marker.pulse ? <Dot size={18} color={tint} pulse style={styles.pulse} /> : null}
      {/* A device that went quiet keeps its place on the map, hollow and faded,
          so a last-known position is never mistaken for a live one. */}
      <View
        style={[
          styles.markerDot,
          marker.stale ? { backgroundColor: '#ffffff', borderColor: tint, borderStyle: 'dashed' } : { backgroundColor: tint },
        ]}
      />

      {marker.label ? (
        <View style={styles.labelWrap}>
          <View style={[styles.markerLabel, marker.stale ? styles.markerLabelStale : null]}>
            <Dot size={6} color={tint} />
            <Txt variant="micro" color="#ffffff" style={styles.markerLabelText} numberOfLines={1}>
              {marker.label}
            </Txt>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

/** conePath is a wedge pointing up (north) from the centre of a 2r × 2r box. */
function conePath(r: number, halfAngleDeg: number): string {
  const a = (halfAngleDeg * Math.PI) / 180;
  const lx = r - r * Math.sin(a);
  const rx = r + r * Math.sin(a);
  const y = r - r * Math.cos(a);
  return `M ${r} ${r} L ${lx.toFixed(2)} ${y.toFixed(2)} A ${r} ${r} 0 0 1 ${rx.toFixed(2)} ${y.toFixed(2)} Z`;
}

/**
 * TrailLayer draws each live marker's recent path as a wake that fades towards
 * its oldest end: one segment per pair of fixes, opacity and width rising with
 * recency.
 */
function TrailLayer({ markers, view, dark }: { markers: MapMarker[]; view: Viewport; dark: boolean }) {
  if (view.width <= 0 || view.height <= 0) return null;
  return (
    <View pointerEvents="none" style={absoluteFill}>
      <Svg width={view.width} height={view.height} pointerEvents="none">
        {markers.map((marker) => {
          const pts = (marker.trail ?? []).map((p) => project(p, view));
          const tint = marker.color ?? toneColor(marker.tone, dark);
          const n = pts.length;
          return (
            <G key={marker.id}>
              {/* A soft casing under the wake, so it reads over a road of a
                  similar colour, satellite imagery or the dark basemap alike. */}
              {pts.map((p, i) => {
                const prev = i > 0 ? pts[i - 1] : undefined;
                if (!prev) return null;
                const recency = i / (n - 1);
                return (
                  <Line
                    key={`casing-${i}`}
                    x1={prev.x}
                    y1={prev.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={dark ? '#0b1020' : '#ffffff'}
                    strokeOpacity={0.55 * recency * recency}
                    strokeWidth={5 + 2.5 * recency}
                    strokeLinecap="round"
                  />
                );
              })}
              {pts.map((p, i) => {
                const prev = i > 0 ? pts[i - 1] : undefined;
                if (!prev) return null;
                const recency = i / (n - 1);
                return (
                  <Line
                    key={i}
                    x1={prev.x}
                    y1={prev.y}
                    x2={p.x}
                    y2={p.y}
                    stroke={tint}
                    strokeOpacity={0.08 + 0.72 * recency * recency}
                    strokeWidth={2 + 2.5 * recency}
                    strokeLinecap="round"
                  />
                );
              })}
            </G>
          );
        })}
      </Svg>
    </View>
  );
}

/**
 * webData exposes values as `data-*` attributes on web, where React Native Web
 * maps `dataSet` onto the DOM node; React Native's types do not know the prop,
 * and native has nowhere to put it.
 */
function webData(data: Record<string, string | number>): object {
  return Platform.OS === 'web' ? { dataSet: data } : {};
}

/** withOpacity accepts the hex tokens and returns an rgba string. */
function withOpacity(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

const styles = StyleSheet.create({
  fence: { position: 'absolute' },
  // The circle's halo, matching the GL renderers' casing line: it keeps the
  // outline readable over rooftops and the dark style, and crisp over streets.
  fenceHaloDark: {
    shadowColor: '#06110b',
    shadowOpacity: 0.6,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 0 },
  },
  fenceHaloLight: {
    shadowColor: '#ffffff',
    shadowOpacity: 0.9,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 0 },
  },
  polygonBox: { position: 'absolute' },
  fenceLabel: {
    position: 'absolute',
    // Centre the pill on the fence without measuring it.
    transform: [{ translateX: -90 }],
    width: 180,
    alignItems: 'center',
  },
  fenceLabelInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingVertical: 4,
    paddingHorizontal: 9,
    ...shadow('float'),
  },
  fenceLabelText: { fontWeight: '600', color: color.textStrong },
  fenceBadgeAmber: {
    backgroundColor: color.amberTagBg,
    borderRadius: radius.sm,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },

  // A zero-size anchor at the marker's coordinate; everything else is placed
  // relative to it, so one transform moves the whole marker.
  anchor: { position: 'absolute', left: 0, top: 0, width: 0, height: 0 },
  anchorStale: { opacity: 0.7 },
  accuracy: { position: 'absolute', borderWidth: 1 },
  cone: { position: 'absolute', left: -CONE_PX, top: -CONE_PX, width: CONE_PX * 2, height: CONE_PX * 2 },
  ripple: {
    position: 'absolute',
    left: -9,
    top: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2.5,
  },
  pulse: { position: 'absolute', left: -9, top: -9 },
  markerDot: {
    position: 'absolute',
    left: -9,
    top: -9,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: '#ffffff',
    ...shadow('float'),
  },
  labelWrap: { position: 'absolute', left: -90, width: 180, bottom: 15, alignItems: 'center' },
  markerLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    maxWidth: 180,
    backgroundColor: color.ink,
    borderRadius: 7,
    paddingVertical: 3,
    paddingHorizontal: 8,
    ...shadow('float'),
  },
  markerLabelStale: { backgroundColor: '#5f6673' },
  markerLabelText: { fontSize: 10.5, fontWeight: '500', flexShrink: 1 },
  smallMarker: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    borderWidth: 3,
  },
});
