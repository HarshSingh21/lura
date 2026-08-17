import { Pressable, StyleSheet, View } from 'react-native';

import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, shadow, size } from '@/theme/tokens';

import { Dot } from '@/components/ui/primitives';
import { metresPerPixel, project, type Viewport } from './projection';
import type { MapFence, MapMarker, MapTone } from './types';

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

export function FenceOverlay({
  fences,
  view,
  dark,
  onPress,
}: {
  fences: MapFence[];
  view: Viewport;
  dark?: boolean;
  onPress?: (id: string) => void;
}) {
  const mpp = metresPerPixel(view.center.lat, view.zoom);

  return (
    <>
      {fences.map((fence) => {
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
                  backgroundColor: withOpacity(stroke, fence.tone === 'amber' ? 0.12 : 0.1),
                  borderColor: withOpacity(stroke, fence.selected ? 0.85 : 0.45),
                  borderWidth: fence.selected ? 2 : 1.5,
                  borderStyle: fence.dashed ? 'dashed' : 'solid',
                },
              ]}
            />
            {fence.name ? (
              <View
                pointerEvents="none"
                style={[styles.fenceLabel, { left: x, top: y - diameter / 2 - 30 }]}
              >
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
              </View>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

export function MarkerOverlay({
  markers,
  view,
  dark,
}: {
  markers: MapMarker[];
  view: Viewport;
  dark?: boolean;
}) {
  return (
    <>
      {markers.map((marker) => {
        const { x, y } = project(marker.point, view);
        if (x < -80 || y < -80 || x > view.width + 80 || y > view.height + 80) return null;
        const tint = toneColor(marker.tone, !!dark);

        if (marker.small) {
          return (
            <View
              key={marker.id}
              pointerEvents="none"
              style={[styles.smallMarker, { left: x - 7, top: y - 7, borderColor: tint }]}
            />
          );
        }

        return (
          <View key={marker.id} pointerEvents="none" style={[styles.marker, { left: x, top: y }]}>
            {marker.label ? (
              <View style={styles.markerLabel}>
                <Dot size={6} color={marker.tone === 'amber' ? palette.amber : palette.accentBright} />
                <Txt variant="micro" color="#ffffff" style={styles.markerLabelText}>
                  {marker.label}
                </Txt>
              </View>
            ) : null}
            <View style={styles.markerDotWrap}>
              {marker.pulse ? (
                <Dot size={17} color={tint} pulse style={styles.markerPulse} />
              ) : null}
              <View style={[styles.markerDot, { backgroundColor: tint }]} />
            </View>
          </View>
        );
      })}
    </>
  );
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
  fenceLabel: {
    position: 'absolute',
    // Centre the pill on the fence without measuring it.
    transform: [{ translateX: -60 }],
    width: 120,
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

  marker: {
    position: 'absolute',
    alignItems: 'center',
    gap: 5,
    transform: [{ translateX: -60 }, { translateY: -46 }],
    width: 120,
  },
  markerLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.ink,
    borderRadius: 7,
    paddingVertical: 3,
    paddingHorizontal: 8,
  },
  markerLabelText: { fontSize: 10.5, fontWeight: '500' },
  markerDotWrap: { width: 17, height: 17, alignItems: 'center', justifyContent: 'center' },
  markerPulse: { position: 'absolute' },
  markerDot: {
    width: 17,
    height: 17,
    borderRadius: 9,
    borderWidth: 3,
    borderColor: '#ffffff',
    ...shadow('float'),
  },
  smallMarker: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#ffffff',
    borderWidth: 3,
  },
});
