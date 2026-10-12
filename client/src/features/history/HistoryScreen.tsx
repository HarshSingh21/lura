import { useMemo, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { downloadUrlFresh } from '@/api/client';
import { useActivity, useHistory, useOverview } from '@/api/hooks';
import type { Place, Point } from '@/api/types';
import { attribution } from '@/components/map/basemaps';
import { BasemapPicker } from '@/components/map/BasemapPicker';
import { MapView } from '@/components/map/MapView';
import type { MapMarker, MapTrack } from '@/components/map/types';
import { useBasemap } from '@/components/map/useBasemap';
import { Icon } from '@/components/ui/Icon';
import { Button, Card, EmptyState, styles as ui } from '@/components/ui/primitives';
import { personColor } from '@/features/people/color';
import { Mono, Txt } from '@/theme/text';
import { color, font, layout, palette, radius, shadow, size, space, withAlpha } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { fitBounds } from '@/components/map/projection';

import {
  buildTimeline,
  dayLabel,
  dayRange,
  formatKm,
  inDay,
  validZone,
  type ActivityFocus,
  type ActivityRow,
} from './activity';

/**
 * History: one day of the user's life with Lura (release spec §7).
 *
 * A day picker (today by default); the map draws that day's track and stops;
 * beside it — below it on a phone — the activity timeline: trips and stops,
 * fence crossings (the user's own, and those of people whose crossings of the
 * user's fences they were entitled to see), reminders and whether they were
 * acknowledged, connection and share changes. Tapping an entry frames it on the
 * map. Days are the user's days, in the zone on their profile.
 *
 * Two product points carried over from the first version: exports are one tap,
 * because data portability is a promise rather than a feature (HLD §11), and the
 * footer says where the history lives.
 */

/** How far back the picker goes; the server keeps more, but a year of arrows is enough. */
const MAX_DAYS_BACK = 365;

export function HistoryScreen() {
  const { isDesktop, width, height } = useLayoutMode();
  const { data: overview } = useOverview();
  const [offset, setOffset] = useState(0);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<{ id: string; seq: number } | undefined>(undefined);
  const [basemap, setBasemap] = useBasemap();
  const offline = overview?.user.airgap || overview?.server.airgap;
  const tz = validZone(overview?.user.tz);
  const viewerId = overview?.user.id;

  // The day window is recomputed when the day changes, not every render, so the
  // query key is stable for the life of the day.
  const range = useMemo(() => dayRange(offset, tz), [offset, tz]);
  const label = dayLabel(offset, tz);

  const devices = useMemo(() => overview?.devices ?? [], [overview?.devices]);
  const activeDevice = deviceId ?? devices[0]?.id;
  const history = useHistory({ deviceId: activeDevice, from: range.from, to: range.to });
  const activity = useActivity({ from: range.from, to: range.to, live: offset === 0 });

  const segments = useMemo(() => history.data?.segments ?? [], [history.data?.segments]);
  const track = useMemo(() => history.data?.track ?? [], [history.data?.track]);

  const sections = useMemo(
    () =>
      buildTimeline(inDay(activity.data?.items ?? [], range), {
        tz,
        viewerId,
        multipleDevices: devices.length > 1,
      }),
    [activity.data?.items, range, tz, viewerId, devices.length],
  );
  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const focused = focus ? rows.find((r) => r.id === focus.id) : undefined;
  const focusGeometry = useMemo(
    () => (focused?.focus ? resolveFocus(focused.focus, overview?.places ?? []) : undefined),
    [focused, overview?.places],
  );

  const mapWidth = isDesktop ? width - layout.sidebarWidth - layout.historyRailWidth : width;
  const mapHeight = isDesktop ? height - layout.topBarHeight : Math.round(height * 0.4);
  // Open on the day; after a tap, on the entry.
  const view = useMemo(() => {
    const points = focusGeometry?.points.length ? focusGeometry.points : track;
    return fitBounds(points, mapWidth, mapHeight, 60);
  }, [focusGeometry, track, mapWidth, mapHeight]);

  const tracks = useMemo<MapTrack[]>(() => {
    const moves = segments
      .filter((s) => s.kind === 'move')
      .map((s) => ({ id: s.id, points: s.path, tone: 'accent' as const, width: 4 }));
    // The raw track is drawn dotted underneath, so gaps between segments are
    // visible rather than silently bridged.
    const base: MapTrack[] =
      track.length > 1 ? [{ id: 'raw', points: track, tone: 'neutral', dotted: true, width: 3 }, ...moves] : moves;
    if (focusGeometry && focusGeometry.points.length > 1) {
      base.push({ id: 'focus', points: focusGeometry.points, tone: 'amber', width: 6 });
    }
    return base;
  }, [segments, track, focusGeometry]);

  const markers = useMemo<MapMarker[]>(() => {
    const stops: MapMarker[] = segments
      .filter((s) => s.kind === 'stop' && s.path.length > 0)
      .map((s) => ({
        id: s.id,
        point: s.path[Math.floor(s.path.length / 2)] ?? s.path[0]!,
        tone: 'accent' as const,
        small: true,
      }));
    if (focusGeometry?.points.length === 1 && focused) {
      stops.push({
        id: `focus:${focused.id}`,
        point: focusGeometry.points[0]!,
        label: focusGeometry.label ?? focused.time,
        tone: 'amber',
        color: focused.personId ? personColor(focused.personId) : undefined,
        rippleKey: focus?.seq,
      });
    }
    return stops;
  }, [segments, focusGeometry, focused, focus?.seq]);

  const select = (row: ActivityRow) => {
    if (!row.focus) return;
    setFocus((prev) => ({ id: row.id, seq: (prev?.seq ?? 0) + 1 }));
  };
  const changeDay = (next: number) => {
    setOffset(Math.max(0, Math.min(MAX_DAYS_BACK, next)));
    setFocus(undefined);
  };

  const loading = activity.isLoading || history.isLoading;

  const timeline = (
    <View style={styles.timeline}>
      <View style={styles.timelineHeader}>
        <Txt variant="h2">Activity</Txt>
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

      <DayPicker offset={offset} label={label} onChange={changeDay} />

      {devices.length > 1 ? (
        <View style={styles.filters}>
          {devices.map((device) => (
            <Pressable
              key={device.id}
              accessibilityRole="button"
              accessibilityState={{ selected: device.id === activeDevice }}
              accessibilityLabel={`Show the track of ${device.name}`}
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

      {activity.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={palette.accent} />
          <Txt variant="small" color={color.textMuted}>
            Reading your day…
          </Txt>
        </View>
      ) : activity.error ? (
        <Card>
          <EmptyState
            title="Could not load the activity"
            body={activity.error instanceof Error ? activity.error.message : undefined}
            action={<Button label="Try again" variant="secondary" small onPress={() => void activity.refetch()} />}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            title={offset === 0 ? 'Nothing yet today' : `Nothing on ${label}`}
            body="Trips, stops, arrivals, reminders and changes to your connections appear here as they happen."
          />
        </Card>
      ) : (
        sections.map((section) => (
          <View key={section.key} style={styles.section}>
            <Mono heading color={color.textFaint} style={styles.sectionTitle}>
              {section.title}
            </Mono>
            {section.rows.map((row, index) => (
              <TimelineRow
                key={`${row.type}:${row.id}`}
                row={row}
                last={index === section.rows.length - 1}
                selected={focus?.id === row.id}
                onPress={row.focus ? () => select(row) : undefined}
              />
            ))}
          </View>
        ))
      )}
    </View>
  );

  return (
    <View style={[styles.root, !isDesktop && styles.rootStacked]}>
      <View style={[styles.mapWrap, !isDesktop && styles.mapWrapStacked]}>
        <MapView
          center={view?.center ?? { lat: 12.9716, lon: 77.5946 }}
          zoom={view?.zoom ?? 13}
          tracks={tracks}
          markers={markers}
          styleUrl={overview?.server.mapStyleUrl}
          basemap={basemap}
          provider={overview?.server.mapProvider}
          mapplsKey={overview?.server.mapplsWebKey}
          offline={offline}
          recenterKey={(focus?.seq ?? 0) * 1_000_000 + track.length + offset * 7}
        />

        {/* Airgap draws the local basemap only, so there is nothing to choose. */}
        {!offline ? (
          <View style={styles.basemapPicker} pointerEvents="box-none">
            <BasemapPicker value={basemap} onChange={setBasemap} />
          </View>
        ) : null}

        <View style={styles.summaryPill} pointerEvents="none">
          <Txt variant="bodySemi" numberOfLines={1}>
            {label} ·{' '}
            <Mono size={size.monoSm} color={color.textSubtle}>
              {formatKm(history.data?.distanceM ?? 0)} · {history.data?.trips ?? 0} trips · {history.data?.stops ?? 0}{' '}
              stops
            </Mono>
          </Txt>
        </View>

        {loading ? (
          <View style={styles.mapLoading} pointerEvents="none">
            <ActivityIndicator size="small" color={palette.accent} />
          </View>
        ) : null}

        <View style={styles.attribution} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            Private history · stored on your infrastructure
          </Mono>
          <Mono size={size.monoTiny} color={color.textSubtle}>
            {attribution(basemap, {
              serverStyleUrl: overview?.server.mapStyleUrl,
              provider: overview?.server.mapProvider,
              offline: !!offline,
            })}
          </Mono>
        </View>
      </View>

      <ScrollView style={isDesktop ? styles.rail : styles.stackedRail} contentContainerStyle={styles.railInner}>
        {timeline}
      </ScrollView>
    </View>
  );
}

function DayPicker({ offset, label, onChange }: { offset: number; label: string; onChange: (next: number) => void }) {
  const atToday = offset === 0;
  const atLimit = offset >= MAX_DAYS_BACK;
  return (
    <View style={styles.dayPicker}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Previous day"
        accessibilityState={{ disabled: atLimit }}
        onPress={atLimit ? undefined : () => onChange(offset + 1)}
        style={({ pressed }) => [styles.dayArrow, pressed && styles.pressed, atLimit && styles.disabled]}
      >
        <View style={styles.rotateLeft}>
          <Icon name="chevron-up" size={15} color={color.textBody} />
        </View>
      </Pressable>
      <View style={styles.dayLabel} accessibilityRole="header" accessibilityLiveRegion="polite">
        <Txt variant="bodySemi">{label}</Txt>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next day"
        accessibilityState={{ disabled: atToday }}
        onPress={atToday ? undefined : () => onChange(offset - 1)}
        style={({ pressed }) => [styles.dayArrow, pressed && styles.pressed, atToday && styles.disabled]}
      >
        <View style={styles.rotateRight}>
          <Icon name="chevron-up" size={15} color={color.textBody} />
        </View>
      </Pressable>
      {!atToday ? (
        <Pressable accessibilityRole="button" onPress={() => onChange(0)} hitSlop={6} style={styles.todayLink}>
          <Txt variant="small" color={palette.accentDark} style={styles.link}>
            Today
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

const ICON_TINT: Partial<Record<ActivityRow['icon'], string>> = {
  passby: palette.amberDark,
  bell: palette.amberDark,
  sharing: palette.amberDark,
};

function TimelineRow({
  row,
  last,
  selected,
  onPress,
}: {
  row: ActivityRow;
  last: boolean;
  selected: boolean;
  onPress?: () => void;
}) {
  const tint = row.personId ? personColor(row.personId) : (ICON_TINT[row.icon] ?? palette.accent);
  const pending = row.status === 'pending';

  const body = (
    <>
      <View style={styles.gutter}>
        <View style={[styles.node, { backgroundColor: withAlpha(tint, 0.14) }]}>
          <Icon name={row.icon} size={13} color={tint} strokeWidth={1.9} />
        </View>
        {!last ? <View style={styles.spine} /> : null}
      </View>
      <View style={[ui.flex, styles.rowBody]}>
        <View style={styles.rowTop}>
          <Mono size={size.monoSm} color={color.textSubtle} style={styles.rowTime}>
            {row.time}
          </Mono>
          <Txt variant="bodySemi" style={ui.flex} numberOfLines={3}>
            {row.title}
          </Txt>
        </View>
        {row.detail || pending ? (
          <View style={styles.rowDetail}>
            {pending ? (
              <View style={styles.pendingChip}>
                <Mono size={size.monoTiny} medium color={palette.amberInk}>
                  PENDING
                </Mono>
              </View>
            ) : null}
            {row.detail ? (
              <Txt variant="tiny" color={color.textSubtle} style={ui.flex}>
                {row.detail}
              </Txt>
            ) : null}
          </View>
        ) : null}
      </View>
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${row.time} ${row.title}${row.detail ? `, ${row.detail}` : ''}. Show on the map.`}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
        styles.row,
        (hovered || pressed) && styles.rowHover,
        selected && styles.rowSelected,
      ]}
    >
      {body}
    </Pressable>
  );
}

/** resolveFocus turns an entry's focus into map points: a path, a point, or a place's centre. */
function resolveFocus(f: ActivityFocus, places: Place[]): { points: Point[]; label?: string } | undefined {
  if (f.path && f.path.length > 0) return { points: f.path };
  if (f.point) return { points: [f.point], label: f.placeName };
  const place =
    (f.placeId ? places.find((p) => p.id === f.placeId) : undefined) ??
    (f.placeName ? places.find((p) => p.name === f.placeName) : undefined);
  if (!place) return undefined;
  // A polygon is framed whole; a circle by its centre.
  if (place.shape === 'polygon' && place.polygon.length >= 3) return { points: place.polygon, label: place.name };
  return { points: [place.center], label: place.name };
}

/**
 * exportHistory opens the export as a download.
 *
 * The URL carries the token as a query parameter because a browser download cannot
 * send an Authorization header. That is a deliberate, narrow exception the server
 * allows on read-only endpoints — and the reason the token is refreshed first: a
 * download that opens in a new tab has no way to retry a 401.
 */
async function exportHistory(
  format: 'gpx' | 'geojson',
  deviceId: string | undefined,
  range: { from: string; to: string },
) {
  const params = new URLSearchParams({ format, from: range.from, to: range.to });
  if (deviceId) params.set('deviceId', deviceId);
  const url = await downloadUrlFresh(`/api/v1/history/export?${params.toString()}`);

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.open(url, '_blank');
    return;
  }
  void Linking.openURL(url);
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', minHeight: 0 },
  rootStacked: { flexDirection: 'column' },
  mapWrap: { flex: 1, backgroundColor: color.mapBg, overflow: 'hidden' },
  // On a phone the map is a band at the top and the timeline scrolls below it.
  mapWrapStacked: { flex: 0, height: '40%', minHeight: 220 },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.35 },

  summaryPill: {
    position: 'absolute',
    top: 16,
    left: 16,
    maxWidth: '70%',
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
    paddingVertical: 9,
    paddingHorizontal: 14,
    ...shadow('float'),
  },
  mapLoading: {
    position: 'absolute',
    top: 64,
    left: 16,
    backgroundColor: color.surface,
    borderRadius: radius.pill,
    padding: 6,
    ...shadow('float'),
  },
  attribution: {
    position: 'absolute',
    left: 10,
    bottom: 8,
    gap: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  basemapPicker: { position: 'absolute', top: 16, right: 16 },

  rail: {
    width: layout.historyRailWidth,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: color.surface,
    borderLeftWidth: 1,
    borderLeftColor: color.hairline,
  },
  stackedRail: {
    flex: 1,
    backgroundColor: color.surface,
    borderTopWidth: 1,
    borderTopColor: color.hairline,
  },
  railInner: { padding: space.xxl, paddingBottom: space.page * 3 },

  timeline: { gap: space.lg },
  timelineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  exportRow: { flexDirection: 'row', gap: space.sm },
  filters: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  filterChip: {
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
  },
  filterChipActive: { backgroundColor: color.accentSoft },

  dayPicker: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  dayArrow: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.borderInput,
    backgroundColor: color.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rotateLeft: { transform: [{ rotate: '-90deg' }] },
  rotateRight: { transform: [{ rotate: '90deg' }] },
  dayLabel: {
    flex: 1,
    minWidth: 0,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: color.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  todayLink: { paddingHorizontal: 4 },
  link: { fontFamily: font.sansMedium },

  loading: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.lg },

  section: { gap: 0 },
  sectionTitle: { letterSpacing: 0.85, marginBottom: space.sm },
  row: { flexDirection: 'row', gap: 11, borderRadius: radius.lg, paddingHorizontal: 4 },
  rowHover: { backgroundColor: color.surfaceHover },
  rowSelected: { backgroundColor: color.amberSofter },
  gutter: { width: 24, alignItems: 'center', paddingTop: 2 },
  node: { width: 24, height: 24, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  spine: { flex: 1, width: 2, backgroundColor: color.hairline, marginTop: 3, minHeight: 8 },
  rowBody: { paddingTop: 4, paddingBottom: space.lg, gap: 3 },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 },
  rowTime: { marginTop: 2, minWidth: 36 },
  rowDetail: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 45 },
  pendingChip: { backgroundColor: color.amberSoft, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 1 },
});
