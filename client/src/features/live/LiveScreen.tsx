import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';

import { useCreatePlace, useOverview, useRevokeShare } from '@/api/hooks';
import type { Point } from '@/api/types';
import { MapView } from '@/components/map/MapView';
import { zoomToInclude, type Box } from '@/components/map/fit';
import type { MapFence, MapMarker } from '@/components/map/types';
import { Icon } from '@/components/ui/Icon';
import { Button, Dot, IconButton, Sheet } from '@/components/ui/primitives';
import { peerFixes, watchers } from '@/features/people/peer';
import { peopleOf } from '@/features/people/types';
import { PlaceForm } from '@/features/places/PlaceForm';
import { Mono, Txt } from '@/theme/text';
import { color, layout, palette, radius, shadow, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { useStore } from '@/state/store';
import { useTracking } from '@/hooks/useTracking';

import { DeviceList, DeviceTracking, PeopleList, SharingBanner, UpcomingReminders } from './rail';

/** Fallback view when a workspace has no places and no fixes yet (central Bengaluru). */
const FALLBACK_CENTER: Point = { lat: 12.9716, lon: 77.5946 };

/**
 * The live map: the screen the product is named for.
 *
 * It composes three things the rest of the app owns — the map renderer, the live
 * position stream from the WebSocket, and the workspace snapshot from the API —
 * and adds the two interactions that only make sense here: drawing a place by
 * tapping the map, and stopping a share from where you can see it is running.
 */
export function LiveScreen() {
  const router = useRouter();
  const { isDesktop, isPhone } = useLayoutMode();
  const { data, isLoading, error } = useOverview();

  const positions = useStore((s) => s.positions);
  const drawing = useStore((s) => s.drawing);
  const setDrawing = useStore((s) => s.setDrawing);
  const selectedPlaceId = useStore((s) => s.selectedPlaceId);
  const selectPlace = useStore((s) => s.selectPlace);
  const selectDevice = useStore((s) => s.selectDevice);
  const selectedDeviceId = useStore((s) => s.selectedDeviceId);
  const sheetOpen = useStore((s) => s.sheetOpen);
  const setSheetOpen = useStore((s) => s.setSheetOpen);
  const tracking = useStore((s) => s.trackingEnabled);
  const setTracking = useStore((s) => s.setTracking);

  const createPlace = useCreatePlace();
  const revokeShare = useRevokeShare();

  const [zoom, setZoom] = useState(14);
  const [recenterKey, setRecenterKey] = useState(0);
  // The map's pixel size, reported back by whichever renderer is in use. Fitting
  // a set of markers is a question about pixels, and the zoom level alone cannot
  // answer it.
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  const [draft, setDraft] = useState<Point | null>(null);

  // This device publishes as the first device in the workspace. A real
  // multi-device setup would pick explicitly; Phase 1 has one phone.
  const primaryDevice = data?.devices[0];
  useTracking({ deviceId: primaryDevice?.id ?? '' });

  const places = data?.places ?? [];
  const devices = data?.devices ?? [];
  // The overview carries the connections a peer marker needs: their device ids
  // (to match live frames) and their last known points (to paint before one
  // arrives). A peer with a paused switch has no devices here at all.
  const people = useMemo(() => peopleOf(data), [data]);
  const seenBy = useMemo(() => watchers(people), [people]);

  /** The map opens on the freshest thing it knows: a live fix, then a last fix,
   *  then the centre of the user's places, then a sensible city. */
  const center = useMemo<Point>(() => {
    if (selectedDeviceId) {
      const chosen = positions[selectedDeviceId]?.point ?? devices.find((d) => d.id === selectedDeviceId)?.lastPoint;
      if (chosen) return chosen;
    }
    const live = Object.values(positions).sort(
      (a, b) => new Date(b.recvTs).getTime() - new Date(a.recvTs).getTime(),
    )[0];
    if (live) return live.point;

    const withFix = devices.find((d) => d.lastPoint);
    if (withFix?.lastPoint) return withFix.lastPoint;

    if (places.length > 0) {
      const lat = places.reduce((sum, p) => sum + p.center.lat, 0) / places.length;
      const lon = places.reduce((sum, p) => sum + p.center.lon, 0) / places.length;
      return { lat, lon };
    }
    return FALLBACK_CENTER;
  }, [positions, devices, places, selectedDeviceId]);

  const fences = useMemo<MapFence[]>(
    () =>
      places.map((place) => {
        const passby = place.triggers.includes('passby');
        return {
          id: place.id,
          center: place.center,
          radiusM: place.radiusM,
          name: place.name,
          // The mock labels a pass-by fence with the trigger and everything else
          // with its radius — the radius matters when you are tuning a fence, the
          // trigger matters when you are wondering why it fired.
          badge: passby ? 'pass-by' : `${place.radiusM}m`,
          tone: passby ? 'amber' : 'accent',
          dashed: passby,
          selected: place.id === selectedPlaceId,
        };
      }),
    [places, selectedPlaceId],
  );

  const markers = useMemo<MapMarker[]>(() => {
    return devices
      .map((device): MapMarker | null => {
        const live = positions[device.id];
        const point = live?.point ?? device.lastPoint;
        if (!point) return null;
        const speed = live?.speedMps ?? device.speedMps ?? 0;
        const moving = speed > 1;
        return {
          id: device.id,
          point,
          label: moving ? `${device.name} · ${Math.round(speed * 3.6)} km/h` : device.name,
          tone: 'accent' as const,
          pulse: moving,
        };
      })
      .filter((m) => m !== null);
  }, [devices, positions]);

  /**
   * Peers are drawn in amber, never in the accent green the user's own devices
   * own, and always carry the person's name: on a map where every dot means "a
   * live human", the one thing a marker must never be ambiguous about is *whose*
   * position it is. Their fixes arrive on the same socket as mine — ordinary
   * `position` frames — so matching a frame to a peer is a device-id lookup.
   */
  const peerMarkers = useMemo<MapMarker[]>(() => {
    return people.flatMap((peer) => {
      const fixes = peerFixes(peer, positions);
      return fixes.map((fix): MapMarker => {
        const base = fixes.length > 1 ? `${peer.peerName} · ${fix.deviceName}` : peer.peerName;
        return {
          id: `peer_${fix.deviceId}`,
          point: fix.point,
          label: fix.moving ? `${base} · ${Math.round(fix.speedMps * 3.6)} km/h` : base,
          tone: 'amber' as const,
        };
      });
    });
  }, [people, positions]);

  // Peers first so my own markers stay on top where they overlap.
  const allMarkers = useMemo(() => [...peerMarkers, ...markers], [peerMarkers, markers]);

  /**
   * Widen the view when someone new appears on it.
   *
   * A peer two kilometres away is off-screen at the default zoom: the marker is
   * on the map and not in front of the person watching, which is the whole point
   * missed. So when the *set* of markers changes — a peer accepts, a second phone
   * comes online — the zoom is pulled out far enough to include everyone.
   *
   * Two deliberate limits. It only ever zooms out (`Math.min`), so it cannot yank
   * someone who has deliberately zoomed in on a street. And it fires on the set of
   * markers, not on their positions, so ordinary movement does not keep re-fitting
   * the map underneath a person who is reading it.
   */
  const markerKey = useMemo(() => allMarkers.map((m) => m.id).sort().join(','), [allMarkers]);
  const [fittedKey, setFittedKey] = useState<string | null>(null);
  if (fittedKey !== markerKey) {
    // Adjusting state during render rather than in an effect: React re-runs this
    // component before committing, so the map is never painted once at the wrong
    // zoom and then again at the right one.
    const fitted = zoomToInclude(
      center,
      allMarkers.map((m) => m.point),
      box,
      // What covers the map differs by shape: a phone has the action buttons on
      // top and the pull-up handle along the bottom; a desktop has the zoom stack
      // in the bottom-right corner and the rail outside the map entirely.
      isPhone ? { top: 90, right: 40, bottom: 130, left: 40 } : { top: 80, right: 90, bottom: 60, left: 50 },
    );
    // `undefined` means there is no viewport yet — leave the key unset so this
    // runs again when the map reports its size.
    if (fitted !== undefined) {
      setFittedKey(markerKey);
      setZoom((current) => Math.min(current, Math.floor(fitted * 10) / 10));
    }
  }

  const rail = (
    <View style={styles.railContent}>
      <SharingBanner
        shares={data?.shares ?? []}
        places={places}
        stopping={revokeShare.isPending}
        onStop={(id) => revokeShare.mutate(id)}
      />
      <PeopleList
        people={people}
        positions={positions}
        onManage={() => {
          // On a phone the rail lives in a sheet, which would otherwise stay
          // open on top of the screen it just navigated to.
          setSheetOpen(false);
          router.push('/people');
        }}
      />
      {isPhone || tracking ? (
        <DeviceTracking
          enabled={tracking}
          deviceName={primaryDevice?.name}
          onToggle={() => setTracking(!tracking)}
        />
      ) : null}
      <DeviceList
        devices={devices}
        positions={positions}
        places={places}
        onSelect={(id) => {
          selectDevice(id);
          // Tapping a device in the rail is a request to look at it.
          setRecenterKey((k) => k + 1);
          setSheetOpen(false);
        }}
      />
      <UpcomingReminders notes={data?.notes ?? []} places={places} />
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.mapWrap}>
        <MapView
          center={center}
          zoom={zoom}
          fences={fences}
          markers={allMarkers}
          styleUrl={data?.server.mapStyleUrl}
          offline={data?.user.airgap || data?.server.airgap}
          recenterKey={recenterKey}
          onViewportChange={(v) => {
            setZoom(v.zoom);
            setBox((prev) => (prev.width === v.width && prev.height === v.height ? prev : { width: v.width, height: v.height }));
          }}
          onPressFence={(id) => selectPlace(id === selectedPlaceId ? undefined : id)}
          onPressMap={
            drawing
              ? (point) => {
                  setDraft(point);
                  setDrawing(false);
                }
              : undefined
          }
        />

        {/* top-left actions */}
        <View style={styles.topActions} pointerEvents="box-none">
          <Button
            label={drawing ? 'Tap the map…' : 'Draw a place'}
            icon={drawing ? undefined : 'plus'}
            onPress={() => setDrawing(!drawing)}
            small={isPhone}
          />
          <Button
            label="Share location"
            variant="secondary"
            onPress={() => router.push('/sharing')}
            small={isPhone}
          />
        </View>

        {drawing ? (
          <View style={styles.drawHint} pointerEvents="none">
            <Txt variant="small" color={color.textMuted}>
              Tap anywhere to drop a geofence there.
            </Txt>
          </View>
        ) : null}

        {/* Map controls sit above the phone's pull-up handle, which otherwise
            covers the recentre button. */}
        <View style={[styles.controls, !isDesktop && styles.controlsPhone]} pointerEvents="box-none">
          <View style={styles.zoomStack}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zoom in"
              onPress={() => setZoom((z) => Math.min(20, z + 1))}
              style={[styles.zoomButton, styles.zoomButtonTop]}
            >
              <Icon name="plus" size={16} color={color.textBody} strokeWidth={2} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zoom out"
              onPress={() => setZoom((z) => Math.max(2, z - 1))}
              style={styles.zoomButton}
            >
              <Icon name="minus" size={16} color={color.textBody} strokeWidth={2} />
            </Pressable>
          </View>
          <IconButton
            name="crosshair"
            accessibilityLabel="Recentre on my device"
            iconColor={color.accent}
            onPress={() => {
              setFittedKey(null); // pressing "locate me" asks for the fit again
              setRecenterKey((k) => k + 1);
            }}
          />
        </View>

        {/* attribution: a licence requirement for OSM-derived tiles */}
        <View style={[styles.attribution, !isDesktop && styles.attributionPhone]} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            {data?.user.airgap ? 'Local basemap · airgap mode' : 'Protomaps · OpenStreetMap · MapLibre'}
          </Mono>
        </View>

        {isLoading ? (
          <View style={styles.statusOverlay} pointerEvents="none">
            <Txt variant="small" color={color.textMuted}>
              Loading your workspace…
            </Txt>
          </View>
        ) : error ? (
          <View style={styles.statusOverlay}>
            <Txt variant="bodySemi">Cannot reach the Lura server</Txt>
            <Txt variant="tiny" color={color.textMuted} style={styles.statusBody}>
              {error instanceof Error ? error.message : 'Unknown error'}
            </Txt>
            <Button label="Open settings" variant="secondary" small onPress={() => router.push('/settings')} />
          </View>
        ) : null}

        {/* phone: a pull-up handle instead of a permanent rail */}
        {!isDesktop ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              seenBy.length > 0
                ? `Show devices, people and reminders. ${seenBy.length} ${seenBy.length === 1 ? 'person' : 'people'} can see your location.`
                : 'Show devices, people and reminders'
            }
            onPress={() => setSheetOpen(true)}
            style={styles.handle}
          >
            <Icon name="chevron-up" size={16} color={color.textMuted} />
            <Txt variant="bodySemi">
              {devices.length} {devices.length === 1 ? 'device' : 'devices'}
              {data?.shares?.length ? ' · sharing' : ''}
            </Txt>
            {/* The rail's "who can see me" block is behind this handle on a
                phone, and HLD §11 does not allow that indicator to be one tap
                away, so its headline rides on the handle itself. */}
            {seenBy.length > 0 ? (
              <View style={styles.handleWatchers}>
                <Dot size={7} color={palette.amberDot} blink />
                <Txt variant="micro" color={palette.amberInk}>
                  {seenBy.length} can see you
                </Txt>
              </View>
            ) : null}
          </Pressable>
        ) : null}
      </View>

      {isDesktop ? (
        <ScrollView style={styles.rail} contentContainerStyle={styles.railInner}>
          {rail}
        </ScrollView>
      ) : (
        <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Live" phone={isPhone}>
          {rail}
        </Sheet>
      )}

      <Sheet
        visible={draft !== null}
        onClose={() => setDraft(null)}
        title="New place"
        phone={isPhone}
      >
        {draft ? (
          <>
            <Txt variant="small" color={color.textMuted}>
              Dropped at{' '}
              <Mono size={size.monoSm} color={color.textBody}>
                {draft.lat.toFixed(5)}, {draft.lon.toFixed(5)}
              </Mono>
            </Txt>
            <PlaceForm
              seedPoint={draft}
              submitting={createPlace.isPending}
              error={createPlace.error instanceof Error ? createPlace.error.message : undefined}
              onCancel={() => setDraft(null)}
              onSubmit={(values) => {
                createPlace.mutate(values, { onSuccess: () => setDraft(null) });
              }}
            />
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', minHeight: 0 },
  mapWrap: { flex: 1, position: 'relative', backgroundColor: color.mapBg, overflow: 'hidden' },

  topActions: {
    position: 'absolute',
    top: 16,
    left: 16,
    flexDirection: 'row',
    gap: 9,
    flexWrap: 'wrap',
    maxWidth: '92%',
  },
  drawHint: {
    position: 'absolute',
    top: 62,
    left: 16,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingHorizontal: 10,
    paddingVertical: 6,
    ...shadow('float'),
  },

  controls: { position: 'absolute', right: 18, bottom: 18, gap: 8, alignItems: 'flex-end' },
  controlsPhone: { bottom: 90 },
  zoomStack: {
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
    overflow: 'hidden',
    ...shadow('button'),
  },
  zoomButton: { width: 38, height: 36, alignItems: 'center', justifyContent: 'center' },
  zoomButtonTop: { borderBottomWidth: 1, borderBottomColor: color.hairlineSoft },

  attribution: { position: 'absolute', left: 14, bottom: 10 },
  attributionPhone: { bottom: 84 },

  statusOverlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: '42%',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: space.xl,
    paddingHorizontal: space.page,
    maxWidth: 420,
    ...shadow('card'),
  },
  statusBody: { textAlign: 'center' },

  handle: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: 12,
    ...shadow('card'),
  },
  handleWatchers: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: color.amberSoft,
    borderRadius: radius.sm,
    paddingVertical: 3,
    paddingHorizontal: 7,
  },

  rail: {
    width: layout.railWidth,
    // React Native Web gives ScrollView flexGrow: 1; without pinning it, this
    // fixed-width rail eats the map.
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: color.surface,
    borderLeftWidth: 1,
    borderLeftColor: color.hairline,
  },
  railInner: { padding: space.xxl },
  railContent: { gap: space.xxl },
});
