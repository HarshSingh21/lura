import { useMemo, useState } from 'react';
import { Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { downloadUrlFresh } from '@/api/client';
import { useHistory, useOverview } from '@/api/hooks';
import type { Segment } from '@/api/types';
import { MapView } from '@/components/map/MapView';
import { Button, Card, EmptyState, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, layout, palette, radius, shadow, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { fitBounds } from '@/components/map/projection';

/**
 * History: the day as a track plus a timeline of trips and stops.
 *
 * The segmentation is the server's (HLD §5.9) — this screen renders it and gets
 * out of the way. Two product points it does make: exports are one tap because
 * data portability is a promise rather than a feature (HLD §11), and the footer
 * says where the history lives, because "private history" is only credible if the
 * UI keeps saying whose infrastructure it is on.
 */

const RANGES = [
  { key: '-24h', label: 'Today' },
  { key: '-72h', label: '3 days' },
  { key: '-168h', label: 'Week' },
  { key: '-720h', label: '30 days' },
] as const;

export function HistoryScreen() {
  const { isDesktop, isPhone, width, height } = useLayoutMode();
  const { data: overview } = useOverview();
  const [range, setRange] = useState<(typeof RANGES)[number]['key']>('-24h');
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);

  const devices = overview?.devices ?? [];
  const activeDevice = deviceId ?? devices[0]?.id;
  const { data, isLoading, error } = useHistory({ deviceId: activeDevice, from: range });

  const segments = data?.segments ?? [];
  const track = data?.track ?? [];

  // Open on the day rather than on a hard-coded city.
  const view = useMemo(
    () => fitBounds(track, isDesktop ? width - layout.historyRailWidth : width, height, 60),
    [track, width, height, isDesktop],
  );

  const tracks = useMemo(() => {
    const moves = segments
      .filter((s) => s.kind === 'move')
      .map((s) => ({ id: s.id, points: s.path, tone: 'accent' as const, width: 4 }));
    // The raw track is drawn dotted underneath, so gaps between segments are
    // visible rather than silently bridged.
    return track.length > 1
      ? [{ id: 'raw', points: track, tone: 'neutral' as const, dotted: true, width: 3 }, ...moves]
      : moves;
  }, [segments, track]);

  const stopMarkers = useMemo(
    () =>
      segments
        .filter((s) => s.kind === 'stop' && s.path.length > 0)
        .map((s) => ({
          id: s.id,
          point: s.path[Math.floor(s.path.length / 2)] ?? s.path[0]!,
          tone: 'accent' as const,
          small: true,
        })),
    [segments],
  );

  const timeline = (
    <View style={styles.timeline}>
      <View style={styles.timelineHeader}>
        <Txt variant="h2">History</Txt>
        <View style={styles.exportRow}>
          <Button label="GPX" variant="ghost" small onPress={() => void exportHistory('gpx', activeDevice, range)} />
          <Button
            label="GeoJSON"
            variant="ghost"
            small
            onPress={() => void exportHistory('geojson', activeDevice, range)}
          />
        </View>
      </View>

      <View style={styles.filters}>
        {RANGES.map((r) => (
          <Pressable
            key={r.key}
            accessibilityRole="button"
            accessibilityState={{ selected: range === r.key }}
            onPress={() => setRange(r.key)}
            style={[styles.filterChip, range === r.key && styles.filterChipActive]}
          >
            <Txt variant="small" color={range === r.key ? palette.accentInk : color.textMuted}>
              {r.label}
            </Txt>
          </Pressable>
        ))}
      </View>

      {devices.length > 1 ? (
        <View style={styles.filters}>
          {devices.map((device) => (
            <Pressable
              key={device.id}
              accessibilityRole="button"
              accessibilityState={{ selected: device.id === activeDevice }}
              onPress={() => setDeviceId(device.id)}
              style={[styles.filterChip, device.id === activeDevice && styles.filterChipActive]}
            >
              <Txt variant="small" color={device.id === activeDevice ? palette.accentInk : color.textMuted}>
                {device.name}
              </Txt>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Txt variant="label" color={color.textSubtle} style={styles.timelineSubtitle}>
        {formatDayLabel(data?.from)} · trips &amp; stops
      </Txt>

      {isLoading ? (
        <Txt variant="small" color={color.textMuted}>
          Reading your history…
        </Txt>
      ) : error ? (
        <Card>
          <EmptyState
            title="Could not load history"
            body={error instanceof Error ? error.message : undefined}
          />
        </Card>
      ) : segments.length === 0 ? (
        <Card>
          <EmptyState
            title="No trips in this window"
            body="History is derived from position fixes. Publish a device's location, or widen the range."
          />
        </Card>
      ) : (
        <View>
          {segments.map((segment, index) => (
            <TimelineRow key={segment.id} segment={segment} last={index === segments.length - 1} />
          ))}
        </View>
      )}
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.mapWrap}>
        <MapView
          center={view?.center ?? { lat: 12.9716, lon: 77.5946 }}
          zoom={view?.zoom ?? 13}
          tracks={tracks}
          markers={stopMarkers}
          styleUrl={overview?.server.mapStyleUrl}
          offline={overview?.user.airgap || overview?.server.airgap}
          recenterKey={track.length}
        />

        <View style={styles.summaryPill} pointerEvents="none">
          <Txt variant="bodySemi">
            {RANGES.find((r) => r.key === range)?.label ?? 'Range'} ·{' '}
            <Mono size={size.monoSm} color={color.textSubtle}>
              {formatKm(data?.distanceM ?? 0)} · {data?.trips ?? 0} trips · {data?.stops ?? 0} stops
            </Mono>
          </Txt>
        </View>

        <View style={styles.attribution} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            Private history · stored on your infrastructure
          </Mono>
        </View>
      </View>

      {isDesktop ? (
        <ScrollView style={styles.rail} contentContainerStyle={styles.railInner}>
          {timeline}
        </ScrollView>
      ) : (
        <ScrollView style={styles.stackedRail} contentContainerStyle={styles.railInner}>
          {timeline}
        </ScrollView>
      )}
    </View>
  );
}

function TimelineRow({ segment, last }: { segment: Segment; last: boolean }) {
  const stop = segment.kind === 'stop';
  const duration = formatDuration(segment.startTs, segment.endTs);

  return (
    <View style={styles.row}>
      <View style={styles.gutter}>
        <View style={[styles.node, stop ? styles.nodeStop : styles.nodeMove]} />
        {!last ? <View style={styles.spine} /> : null}
      </View>

      <View style={[ui.flex, styles.rowBody]}>
        {stop ? (
          <>
            <Txt variant="bodySemi" color={color.textMuted}>
              Stopped at {segment.atPlace || 'an unnamed spot'}
            </Txt>
            <Txt variant="tiny" color={color.textFaint}>
              {duration} · {formatRange(segment.startTs, segment.endTs)}
            </Txt>
          </>
        ) : (
          <>
            <Txt variant="bodySemi">
              {segment.fromPlace || 'Somewhere'} → {segment.toPlace || 'somewhere'}
            </Txt>
            <View style={styles.moveMeta}>
              <Txt variant="tiny" color={palette.accentMode}>
                {segment.mode}
              </Txt>
              <Txt variant="tiny" color={color.textSubtle}>
                {duration}
              </Txt>
              <Txt variant="tiny" color={color.textSubtle}>
                {formatKm(segment.distanceM)}
              </Txt>
            </View>
            <Mono size={size.monoTiny} color={color.textFaint}>
              {formatRange(segment.startTs, segment.endTs)}
            </Mono>
          </>
        )}
      </View>
    </View>
  );
}

/**
 * exportHistory opens the export as a download.
 *
 * The URL carries the token as a query parameter because a browser download cannot
 * send an Authorization header. That is a deliberate, narrow exception the server
 * allows on read-only endpoints — and the reason the token is refreshed first: a
 * download that opens in a new tab has no way to retry a 401.
 */
async function exportHistory(format: 'gpx' | 'geojson', deviceId: string | undefined, from: string) {
  const params = new URLSearchParams({ format, from });
  if (deviceId) params.set('deviceId', deviceId);
  const url = await downloadUrlFresh(`/api/v1/history/export?${params.toString()}`);

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank');
    return;
  }
  void Linking.openURL(url);
}

function formatKm(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

function formatDuration(startTs: string, endTs: string): string {
  const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatRange(startTs: string, endTs: string): string {
  const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  const start = new Date(startTs);
  const end = new Date(endTs);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '';
  return `${start.toLocaleTimeString(undefined, opts)} – ${end.toLocaleTimeString(undefined, opts)}`;
}

function formatDayLabel(from?: string): string {
  if (!from) return 'Recent';
  const date = new Date(from);
  if (Number.isNaN(date.getTime())) return 'Recent';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', minHeight: 0 },
  mapWrap: { flex: 1, backgroundColor: color.mapBg, overflow: 'hidden' },

  summaryPill: {
    position: 'absolute',
    top: 16,
    left: 16,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
    paddingVertical: 9,
    paddingHorizontal: 14,
    ...shadow('float'),
  },
  attribution: { position: 'absolute', left: 14, bottom: 10 },

  rail: {
    width: layout.historyRailWidth,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: color.surface,
    borderLeftWidth: 1,
    borderLeftColor: color.hairline,
  },
  stackedRail: {
    // On a phone the map is a band at the top and the timeline scrolls below it.
    maxHeight: '58%',
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
  },
  railInner: { padding: space.xxl + 2 },

  timeline: { gap: space.lg },
  timelineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  exportRow: { flexDirection: 'row', gap: space.sm },
  timelineSubtitle: { marginTop: -4 },
  filters: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  filterChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  filterChipActive: { backgroundColor: color.accentSoft },

  row: { flexDirection: 'row', gap: 13 },
  gutter: { width: 14, alignItems: 'center' },
  node: { width: 11, height: 11, borderRadius: 6, marginTop: 4 },
  nodeMove: { backgroundColor: palette.accent },
  nodeStop: { backgroundColor: color.surface, borderWidth: 2, borderColor: color.timelineNode },
  spine: { flex: 1, width: 2, backgroundColor: color.hairline, marginTop: 3 },
  rowBody: { paddingBottom: space.xl, gap: 2 },
  moveMeta: { flexDirection: 'row', gap: 12, marginTop: 1 },
});
