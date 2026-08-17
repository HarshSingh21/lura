import { useState } from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, Ellipse, G, Line, Path, Rect } from 'react-native-svg';

import { color } from '@/theme/tokens';

import { absoluteFill } from './fill';

import { FenceOverlay, MarkerOverlay, toneColor } from './Overlays';
import { project, unproject, type Viewport } from './projection';
import type { MapViewProps } from './types';

/**
 * The locally drawn basemap.
 *
 * This is not a placeholder — it is a real product surface, used in three places:
 *
 *   1. Airgap mode (HLD §11), where fetching a remote basemap would break the
 *      promise that nothing leaves the operator's network.
 *   2. Expo Go, which cannot load MapLibre's native module.
 *   3. The small previews (place cards, share preview), where a full GL context
 *      per card would be wasteful.
 *
 * It draws the same abstract city the design mock does — blocks, roads, a park, a
 * river — and then hands off to the shared overlays, so fences and markers behave
 * identically to the GL renderers.
 */
export function MapCanvas(props: MapViewProps) {
  const {
    center,
    zoom = 14,
    fences = [],
    markers = [],
    tracks = [],
    variant = 'light',
    onPressMap,
    onViewportChange,
  } = props;
  const dark = variant === 'dark';
  const [box, setBox] = useState({ width: 0, height: 0 });

  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    if (width !== box.width || height !== box.height) {
      setBox({ width, height });
      // The canvas has no gestures of its own, so the viewport is exactly what
      // the caller asked for — reported back so shared controls behave the same.
      onViewportChange?.({ center, zoom, width, height });
    }
  };

  const view: Viewport = { center, zoom, width: box.width, height: box.height };
  const ready = box.width > 0 && box.height > 0;

  return (
    <Pressable
      onLayout={onLayout}
      onPress={
        onPressMap
          ? (event) => {
              const { locationX, locationY } = event.nativeEvent;
              onPressMap(unproject(locationX, locationY, view));
            }
          : undefined
      }
      style={[styles.container, { backgroundColor: dark ? color.inkPanel : color.mapBg }]}
    >
      {ready ? (
        <>
          <Basemap width={box.width} height={box.height} dark={dark} />

          {/* Tracks are drawn in the same SVG layer so they sit under the overlays. */}
          <Svg width={box.width} height={box.height} style={absoluteFill}>
            {tracks.map((track) => {
              const pts = track.points.map((p) => project(p, view));
              if (pts.length < 2) return null;
              const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
              const stroke = toneColor(track.tone, dark);
              return (
                <Path
                  key={track.id}
                  d={d}
                  stroke={stroke}
                  strokeWidth={track.width ?? 4}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                  strokeDasharray={track.dotted ? '1 10' : undefined}
                />
              );
            })}
          </Svg>

          <FenceOverlay fences={fences} view={view} dark={dark} onPress={props.onPressFence} />
          <MarkerOverlay markers={markers} view={view} dark={dark} />
        </>
      ) : null}
    </Pressable>
  );
}

/**
 * Basemap draws an abstract city.
 *
 * The geometry is deliberately deterministic (no randomness): a map that
 * reshuffles its streets on every render reads as broken, and a stable drawing can
 * be recognised across screens.
 */
function Basemap({ width, height, dark }: { width: number; height: number; dark: boolean }) {
  const roadColor = dark ? color.inkPanelLine : color.mapRoad;
  const blockColor = dark ? '#28332c' : color.mapBlock;

  // Lay the grid out in proportion to the viewport so it looks intentional at any
  // size, from a 96 px card preview to a full-screen map.
  const cols = Math.max(2, Math.round(width / 220));
  const rows = Math.max(2, Math.round(height / 190));
  const colStep = width / (cols + 1);
  const rowStep = height / (rows + 1);
  const roadWidth = Math.max(3, Math.min(9, width / 120));

  const blocks: { x: number; y: number; w: number; h: number }[] = [];
  for (let c = 0; c <= cols; c += 1) {
    for (let r = 0; r <= rows; r += 1) {
      // Skip a couple of cells so the grid is not uniform: the park and river sit
      // in the gaps.
      if ((c + r) % 3 === 0) continue;
      const pad = Math.min(18, colStep * 0.16);
      blocks.push({
        x: c * colStep + pad,
        y: r * rowStep + pad,
        w: Math.max(8, colStep - pad * 2),
        h: Math.max(8, rowStep - pad * 2),
      });
    }
  }

  return (
    <Svg width={width} height={height} style={absoluteFill}>
      <Rect x={0} y={0} width={width} height={height} fill={dark ? color.inkPanel : color.mapBg} />

      {blocks.map((b, i) => (
        <Rect key={`b${i}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={Math.min(10, b.w / 6)} fill={blockColor} />
      ))}

      {/* park */}
      <Ellipse
        cx={width * 0.47}
        cy={height * 0.67}
        rx={Math.min(150, width * 0.18)}
        ry={Math.min(110, height * 0.16)}
        fill={dark ? '#2b3a30' : color.mapPark}
      />

      {/* river along the bottom */}
      <Path
        d={`M -20 ${height * 0.9} Q ${width * 0.26} ${height * 0.84} ${width * 0.42} ${height * 0.94} T ${width + 20} ${height * 0.89} L ${width + 20} ${height + 20} L -20 ${height + 20} Z`}
        fill={dark ? '#25353a' : color.mapWater}
      />

      {/* street grid */}
      <G stroke={roadColor} strokeWidth={roadWidth} strokeLinecap="round">
        {Array.from({ length: rows + 1 }, (_, r) => (
          <Line key={`h${r}`} x1={0} y1={(r + 1) * rowStep} x2={width} y2={(r + 1) * rowStep} />
        ))}
        {Array.from({ length: cols + 1 }, (_, c) => (
          <Line key={`v${c}`} x1={(c + 1) * colStep} y1={0} x2={(c + 1) * colStep} y2={height} />
        ))}
      </G>

      {/* one arterial road cutting across, as in the mock */}
      <Path
        d={`M -20 ${height * 0.9} L ${width * 0.32} ${height * 0.67} L ${width * 0.56} ${height * 0.43} L ${width * 0.82} ${height * 0.17} L ${width + 20} ${height * 0.06}`}
        stroke={dark ? '#3c4a41' : color.mapArterial}
        strokeWidth={roadWidth * 1.8}
        fill="none"
        strokeLinecap="round"
      />

      {/* a hint of the accent, so an empty map still feels like Lura */}
      <Circle cx={width * 0.5} cy={height * 0.5} r={0} fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, overflow: 'hidden' },
});
