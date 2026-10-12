import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Svg, { Circle, Path } from 'react-native-svg';

import { useCreatePlace, useOverview, useRevokeShare, useUpdatePlaceGeometry } from '@/api/hooks';
import type { Place, Point } from '@/api/types';
import { attribution } from '@/components/map/basemaps';
import { BasemapPicker } from '@/components/map/BasemapPicker';
import { MapView } from '@/components/map/MapView';
import { zoomToInclude, type Box } from '@/components/map/fit';
import { formatMetres } from '@/components/map/geometry';
import { fitBounds } from '@/components/map/projection';
import type { FenceEditState, FenceGeometry, MapFence, MapMarker } from '@/components/map/types';
import { useBasemap } from '@/components/map/useBasemap';
import { Icon } from '@/components/ui/Icon';
import { Button, Dot, IconButton, Sheet } from '@/components/ui/primitives';
import { peerFixes, watchers } from '@/features/people/peer';
import { peopleOf } from '@/features/people/types';
import { PlaceForm } from '@/features/places/PlaceForm';
import { Mono, Txt } from '@/theme/text';
import { color, layout, palette, radius, shadow, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';
import { useStore } from '@/state/store';
import { useGpsStatus } from '@/hooks/usePublishing';

import { colorForUser, formatSpeed, glideMsFor, headingFor, MOVING_MPS, speedOf, type TrailPoint } from './motion';
import { DeviceList, DeviceTracking, PeopleList, SharingBanner, UpcomingReminders, useNow, type FollowKey } from './rail';
import { useTrails } from './trails';

/** A ping older than this no longer pulses: the person may have gone offline. */
const LIVE_PULSE_MS = 120_000;

/** Follow mode never eases faster than this, so a jump still reads as motion. */
const MIN_FOLLOW_MS = 450;

/**
 * The last focus request (from a toast or the notification panel) this screen
 * acted on. Module-level so coming back to the map later does not replay an old
 * "show me Nishtha".
 */
let consumedFocusSeq = 0;

/** Fallback view when a workspace has no places and no fixes yet (central Bengaluru). */
const FALLBACK_CENTER: Point = { lat: 12.9716, lon: 77.5946 };

/** The fence id the editor uses for a shape that has been drawn but not saved yet. */
const DRAFT_ID = '__draft__';

type DrawMode = 'draw-circle' | 'draw-polygon' | 'draw-freehand';

const DRAW_MODES: { mode: DrawMode; label: string }[] = [
  { mode: 'draw-circle', label: 'Circle' },
  { mode: 'draw-polygon', label: 'Polygon' },
  { mode: 'draw-freehand', label: 'Freehand' },
];

/** geometryOfPlace is a place's fence as the editor understands it. */
function geometryOfPlace(place: Place): FenceGeometry {
  return place.shape === 'polygon' && place.polygon.length >= 3
    ? { shape: 'polygon', polygon: place.polygon }
    : { shape: 'circle', center: place.center, radiusM: place.radiusM };
}

function editState(fenceId: string, geometry: FenceGeometry): FenceEditState {
  return geometry.shape === 'circle'
    ? { mode: 'edit', fenceId, shape: 'circle', center: geometry.center, radiusM: geometry.radiusM }
    : { mode: 'edit', fenceId, shape: 'polygon', polygon: geometry.polygon };
}

/** zoomForRadius frames a fence of this size with room around it. */
function zoomForRadius(radiusM: number): number {
  if (radiusM > 1500) return 13;
  if (radiusM > 600) return 14;
  if (radiusM > 250) return 15;
  return 16;
}

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
  const trails = useTrails((s) => s.trails);
  const lastEvent = useStore((s) => s.lastEvent);
  const pushToast = useStore((s) => s.pushToast);
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
  const updateGeometry = useUpdatePlaceGeometry();

  // Two zooms, deliberately apart: `zoom` is what this screen *asks* the map
  // for (buttons, fits, "show me"), `viewZoom` is what the map reports it is
  // showing. Mirroring the report back into the request made every animated
  // zoom stop on its first frame — the frame's zoom came back as a new target.
  const [zoom, setZoom] = useState(14);
  const [viewZoom, setViewZoom] = useState(14);
  // A request equal to the previous one would not change the prop, and the map
  // only moves on a change (the user may have pinched away since): nudge it.
  const requestZoom = (next: number) => setZoom((prev) => (Math.abs(prev - next) < 1e-9 ? next + 1e-6 : next));
  const [recenterKey, setRecenterKey] = useState(0);
  // The map's pixel size, reported back by whichever renderer is in use. Fitting
  // a set of markers is a question about pixels, and the zoom level alone cannot
  // answer it.
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  // The geofence editor: a draw mode, or an existing (or just-drawn) fence
  // being moved and reshaped. `draft` is a drawn shape waiting for its form.
  const [fenceEdit, setFenceEdit] = useState<FenceEditState | null>(null);
  const [drawMenu, setDrawMenu] = useState(false);
  const [draft, setDraft] = useState<FenceGeometry | null>(null);
  // The last geometry the server accepted for the fence being edited, which is
  // what a failed save rolls back to.
  const [committed, setCommitted] = useState<FenceGeometry | null>(null);
  // Where the camera should look while a fence is being edited; it wins over
  // the live position until the user recentres.
  const [editFocus, setEditFocus] = useState<Point | null>(null);
  const editingId = fenceEdit?.mode === 'edit' ? fenceEdit.fenceId : undefined;
  const drawingMode = fenceEdit && fenceEdit.mode !== 'edit' ? fenceEdit.mode : undefined;
  const [basemap, setBasemap] = useBasemap();
  // Whom the camera is following, if anyone (a person or one of my devices).
  const [followKey, setFollowKey] = useState<FollowKey | undefined>(undefined);
  // The centre chosen by fitting everyone into view on first load.
  const [fitCenter, setFitCenter] = useState<Point | null>(null);

  // "Show me" from a notification: frame the place or person and pull the camera
  // in. The request already selected them (features/notify/ui); navigating here
  // is the Shell's job. Adjusted during render, like the fit below, so the map
  // never paints a frame at the old view.
  const focus = useStore((s) => s.focus);
  const [focusSeen, setFocusSeen] = useState(() => consumedFocusSeq);
  const [focusPoint, setFocusPoint] = useState<Point | null>(null);
  if (focus && focus.seq > focusSeen) {
    setFocusSeen(focus.seq);
    setFocusPoint(focus.point ?? null);
    // "Show me" replaces whatever the camera was doing: following someone else
    // or holding the first-load fit.
    setFollowKey(undefined);
    setFitCenter(null);
    requestZoom(Math.max(viewZoom, 16));
    setRecenterKey((k) => k + 1);
  }
  useEffect(() => {
    consumedFocusSeq = focusSeen;
  }, [focusSeen]);

  // Publishing runs in the app layout (hooks/usePublishing), so it carries on
  // on every screen; the rail only shows it and flips the switch.
  const primaryDevice = data?.devices[0];
  const gps = useGpsStatus();
  // A coarse clock for "is this ping still live": a marker stops pulsing within
  // ~15 s of its device going quiet, without re-rendering the map every second.
  const pulseNow = useNow(15_000);
  const meId = data?.user.id;
  const offline = data?.user.airgap || data?.server.airgap;

  // Memoised so "no data yet" is the same empty array between renders.
  const places = useMemo(() => data?.places ?? [], [data?.places]);
  const devices = useMemo(() => data?.devices ?? [], [data?.devices]);
  // The overview carries the connections a peer marker needs: their device ids
  // (to match live frames) and their last known points (to paint before one
  // arrives). A peer with a paused switch has no devices here at all.
  const people = useMemo(() => peopleOf(data), [data]);
  const seenBy = useMemo(() => watchers(people), [people]);
  const peerColors = useMemo(
    () => Object.fromEntries(people.map((p) => [p.peerId, colorForUser(p.peerId, meId, palette.accent)])),
    [people, meId],
  );

  /** The map opens on the freshest thing it knows about *me*: a live fix, then a
   *  last fix, then the centre of the user's places, then a sensible city.
   *
   *  Only my own devices steer the camera by default. Following whoever pinged
   *  last would bounce the view between Harsh and Nishtha on every fix, and
   *  pin the peer to the middle of the screen so they never appear to move —
   *  watching someone else is what follow mode is for. */
  const center = useMemo<Point>(() => {
    if (editFocus) return editFocus;
    if (selectedDeviceId) {
      const chosen = positions[selectedDeviceId]?.point ?? devices.find((d) => d.id === selectedDeviceId)?.lastPoint;
      if (chosen) return chosen;
    }
    if (focusPoint) return focusPoint;
    if (fitCenter) return fitCenter;
    const mine = new Set(devices.map((d) => d.id));
    const live = Object.values(positions)
      .filter((p) => mine.has(p.deviceId))
      .sort((a, b) => new Date(b.recvTs).getTime() - new Date(a.recvTs).getTime())[0];
    if (live) return live.point;

    const withFix = devices.find((d) => d.lastPoint);
    if (withFix?.lastPoint) return withFix.lastPoint;

    if (places.length > 0) {
      const lat = places.reduce((sum, p) => sum + p.center.lat, 0) / places.length;
      const lon = places.reduce((sum, p) => sum + p.center.lon, 0) / places.length;
      return { lat, lon };
    }
    return FALLBACK_CENTER;
  }, [editFocus, positions, devices, places, selectedDeviceId, focusPoint, fitCenter]);

  const fences = useMemo<MapFence[]>(
    () =>
      // The fence being edited is drawn by the editor itself, live under the
      // finger; drawing it here too would leave a stale copy behind the drag.
      places.filter((place) => place.id !== editingId).map((place) => {
        const passby = place.triggers.includes('passby');
        return {
          id: place.id,
          center: place.center,
          radiusM: place.radiusM,
          polygon: place.shape === 'polygon' && place.polygon.length >= 3 ? place.polygon : undefined,
          name: place.name,
          // The mock labels a pass-by fence with the trigger and everything else
          // with its radius — the radius matters when you are tuning a fence, the
          // trigger matters when you are wondering why it fired.
          // A polygon's radius is only its bounding circle, which would mislead.
          badge: passby ? 'pass-by' : place.shape === 'polygon' ? 'area' : `${place.radiusM}m`,
          tone: passby ? 'amber' : 'accent',
          dashed: passby,
          selected: place.id === selectedPlaceId,
        };
      }),
    [places, selectedPlaceId, editingId],
  );

  /**
   * A live marker is built from the device's recent fixes: where it is, which
   * way it is heading, how long to glide there, how sure the GPS is, and the
   * wake behind it. Everything here is derived per fix, never per frame — the
   * glide itself runs inside the marker (Overlays.tsx).
   */
  const liveMarker = (
    id: string,
    deviceId: string,
    point: Point,
    label: string,
    colour: string,
    fallbackSpeed: number,
  ): MapMarker => {
    const trail: TrailPoint[] = trails[deviceId] ?? [];
    const live = positions[deviceId];
    const speed = trail.length > 0 ? speedOf(trail) : fallbackSpeed;
    const lastSeen = live ? new Date(live.recvTs).getTime() : undefined;
    const arrived = lastEvent && lastEvent.deviceId === deviceId && lastEvent.trigger === 'arrive' ? lastEvent.id : undefined;
    return {
      id,
      point,
      label: speed > MOVING_MPS ? `${label} · ${formatSpeed(speed)}` : label,
      color: colour,
      pulse: lastSeen !== undefined && pulseNow - lastSeen < LIVE_PULSE_MS,
      headingDeg: headingFor(trail),
      accuracyM: live?.accuracyM || undefined,
      animateMs: glideMsFor(trail),
      rippleKey: arrived,
      trail: trail.length > 1 ? trail.map((t) => t.point) : undefined,
    };
  };

  const markers = useMemo<MapMarker[]>(() => {
    return devices
      .map((device): MapMarker | null => {
        const live = positions[device.id];
        const point = live?.point ?? device.lastPoint;
        if (!point) return null;
        return liveMarker(device.id, device.id, point, device.name, palette.accent, live?.speedMps ?? device.speedMps ?? 0);
      })
      .filter((m) => m !== null);
    // liveMarker reads exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [devices, positions, trails, lastEvent, pulseNow]);

  /**
   * Each peer gets their own colour — never the accent green my own devices
   * own — and always carries their name: on a map where every dot means "a live
   * human", the one thing a marker must never be ambiguous about is *whose*
   * position it is. Their fixes arrive on the same socket as mine — ordinary
   * `position` frames — so matching a frame to a peer is a device-id lookup.
   */
  const peerMarkers = useMemo<MapMarker[]>(() => {
    return people.flatMap((peer) => {
      const fixes = peerFixes(peer, positions);
      return fixes.map((fix): MapMarker => {
        const base = fixes.length > 1 ? `${peer.peerName} · ${fix.deviceName}` : peer.peerName;
        return liveMarker(
          `peer_${fix.deviceId}`,
          fix.deviceId,
          fix.point,
          base,
          peerColors[peer.peerId] ?? palette.amber,
          fix.speedMps,
        );
      });
    });
    // liveMarker reads exactly these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, positions, trails, lastEvent, peerColors, pulseNow]);

  // Peers first so my own markers stay on top where they overlap.
  const allMarkers = useMemo(() => [...peerMarkers, ...markers], [peerMarkers, markers]);

  /**
   * Follow mode: the camera stays on one person. A person is resolved to their
   * freshest device's marker, so following Nishtha keeps working when she
   * switches from her phone to her laptop.
   */
  const followed = useMemo<MapMarker | undefined>(() => {
    if (!followKey) return undefined;
    if (followKey.startsWith('device:')) {
      const id = followKey.slice('device:'.length);
      return allMarkers.find((m) => m.id === id);
    }
    const userId = followKey.slice('user:'.length);
    const peer = people.find((p) => p.peerId === userId);
    if (!peer) return undefined;
    const freshest = peerFixes(peer, positions).sort(
      (a, b) => new Date(b.lastSeen ?? 0).getTime() - new Date(a.lastSeen ?? 0).getTime(),
    )[0];
    return freshest ? allMarkers.find((m) => m.id === `peer_${freshest.deviceId}`) : undefined;
  }, [followKey, allMarkers, people, positions]);
  const followName = followed?.label?.split(' · ')[0];

  const startFollowing = (key: FollowKey | undefined) => {
    setFollowKey(key);
    if (key) {
      selectDevice(undefined);
      // Following someone from city level is not following them.
      requestZoom(Math.max(viewZoom, 15));
    }
    setSheetOpen(false);
  };

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
  // Whether everyone has been framed together yet. That happens once — the
  // first time there is more than one person to show, which is usually not the
  // first load: my own marker comes first, the peer's a ping later — and again
  // after "locate me". Every other change of the set only ever zooms out.
  const [crowdFramed, setCrowdFramed] = useState(false);
  if (fittedKey !== markerKey && !followKey) {
    // Adjusting state during render rather than in an effect: React re-runs this
    // component before committing, so the map is never painted once at the wrong
    // zoom and then again at the right one.
    //
    // What covers the map differs by shape: a phone has the action buttons on
    // top and the pull-up handle along the bottom; a desktop has the zoom stack
    // in the bottom-right corner and the rail outside the map entirely.
    const insets = isPhone ? { top: 90, right: 40, bottom: 130, left: 40 } : { top: 80, right: 90, bottom: 60, left: 50 };
    const points = allMarkers.map((m) => m.point);
    // With no fix of my own the camera has nothing to stand on (it would sit on
    // the fallback city while the one person I can see is off-screen), so a
    // single peer is framed like a crowd.
    const ownFix = markers.length > 0;
    if (!crowdFramed && (points.length > 1 || (points.length === 1 && !ownFix)) && box.width > 0 && box.height > 0) {
      // The first time there is more than one person on it: frame everyone,
      // centred on all of them rather than on whoever pinged last — "where are we both" is
      // the first question the live map answers.
      const fit = fitBounds(points, box.width, box.height, Math.max(insets.top, insets.bottom, insets.left, insets.right), 16);
      if (fit) {
        setFittedKey(markerKey);
        setCrowdFramed(true);
        setFitCenter(fit.center);
        requestZoom(Math.floor(fit.zoom * 10) / 10);
        setRecenterKey((k) => k + 1);
      }
    } else {
      const fitted = zoomToInclude(center, points, box, insets);
      // `undefined` means there is no viewport yet — leave the key unset so this
      // runs again when the map reports its size.
      if (fitted !== undefined) {
        setFittedKey(markerKey);
        const wanted = Math.floor(fitted * 10) / 10;
        if (wanted < viewZoom) requestZoom(wanted);
      }
    }
  }

  // In follow mode the camera eases to each fix over the same time the marker
  // glides there, so the person stays still on screen while the city moves.
  const mapCenter = followed?.point ?? center;
  const followMs = followed ? Math.max(MIN_FOLLOW_MS, followed.animateMs ?? 0) : undefined;

  const selectedPlace = places.find((p) => p.id === selectedPlaceId);

  /** startEdit puts an existing fence under the editor and brings it into view. */
  const startEdit = (place: Place) => {
    const geometry = geometryOfPlace(place);
    setCommitted(geometry);
    setDrawMenu(false);
    // The fence, not a moving person, is what the camera should hold still on.
    setFollowKey(undefined);
    setFenceEdit(editState(place.id, geometry));
    setEditFocus(place.center);
    requestZoom(zoomForRadius(place.radiusM));
    setRecenterKey((k) => k + 1);
  };

  const stopEditing = () => {
    setFenceEdit(null);
    setDraft(null);
    setCommitted(null);
  };

  // "Edit on map" from the Places screen arrives as ?edit=<placeId>. Handled
  // during render, like the zoom fit above, so the map never paints a frame
  // without the editor; the param is cleared afterwards so a reload or a tab
  // switch does not re-enter edit mode.
  const { edit: editParam } = useLocalSearchParams<{ edit?: string }>();
  const [handledEdit, setHandledEdit] = useState<string | undefined>(undefined);
  if (editParam && editParam !== handledEdit && data) {
    setHandledEdit(editParam);
    const place = places.find((p) => p.id === editParam);
    if (place) startEdit(place);
  }
  useEffect(() => {
    if (editParam && editParam === handledEdit) router.setParams({ edit: undefined });
  }, [editParam, handledEdit, router]);

  /**
   * onFenceGeometry is the editor's report. While a gesture runs it only
   * mirrors the geometry; at the end of one it either opens the form (a new
   * shape) or saves (an existing fence — optimistically, rolled back with a
   * toast if the server refuses).
   */
  const onFenceGeometry = (geometry: FenceGeometry, done: boolean) => {
    const current = fenceEdit;
    if (!current) return;
    if (current.mode === 'draw-polygon' && geometry.shape === 'polygon' && !done) {
      setFenceEdit({ mode: 'draw-polygon', vertices: geometry.polygon });
      return;
    }
    if (current.mode !== 'edit') {
      if (!done) return; // circle and freehand previews are drawn by the editor
      // A finished shape becomes an editable draft behind the form.
      setFenceEdit(editState(DRAFT_ID, geometry));
      setDraft(geometry);
      return;
    }
    const id = current.fenceId;
    setFenceEdit(editState(id, geometry));
    if (!done) return;
    if (id === DRAFT_ID) {
      setDraft(geometry);
      return;
    }
    const previous = committed;
    setCommitted(geometry);
    updateGeometry.mutate(
      { id, geometry },
      {
        onError: (err) => {
          setCommitted(previous);
          if (previous) {
            setFenceEdit((now) => (now?.mode === 'edit' && now.fenceId === id ? editState(id, previous) : now));
          }
          pushToast({
            kind: 'error',
            title: 'Could not save the fence',
            body: err instanceof Error ? err.message : 'The server refused the new shape.',
          });
        },
      },
    );
  };

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
        trails={trails}
        colors={peerColors}
        followKey={followKey}
        onFollow={startFollowing}
        onManage={() => {
          // On a phone the rail lives in a sheet, which would otherwise stay
          // open on top of the screen it just navigated to.
          setSheetOpen(false);
          router.push('/people');
        }}
      />
      {/* Every screen can publish: a laptop on the move is a tracked device too,
          and two people watching each other from two browsers is the point. */}
      {data ? (
        <DeviceTracking
          enabled={tracking}
          deviceName={devices.find((d) => d.id === gps.deviceId)?.name ?? primaryDevice?.name}
          status={gps}
          onToggle={() => setTracking(!tracking)}
        />
      ) : null}
      <DeviceList
        devices={devices}
        positions={positions}
        places={places}
        trails={trails}
        followKey={followKey}
        onFollow={startFollowing}
        onSelect={(id) => {
          setFollowKey(undefined);
          selectDevice(id);
          setFocusPoint(null);
          // Tapping a device in the rail is a request to look at it, at the
          // zoom the map is at now.
          requestZoom(viewZoom);
          setRecenterKey((k) => k + 1);
          setSheetOpen(false);
        }}
      />
      <UpcomingReminders notes={data?.notes ?? []} places={places} people={people} />
    </View>
  );

  return (
    <View style={styles.root}>
      <View style={styles.mapWrap}>
        <MapView
          center={mapCenter}
          zoom={zoom}
          fences={fences}
          markers={allMarkers}
          styleUrl={data?.server.mapStyleUrl}
          basemap={basemap}
          provider={data?.server.mapProvider}
          mapplsKey={data?.server.mapplsWebKey}
          offline={offline}
          recenterKey={recenterKey}
          followMs={followMs}
          onViewportChange={(v) => {
            setViewZoom(v.zoom);
            setBox((prev) => (prev.width === v.width && prev.height === v.height ? prev : { width: v.width, height: v.height }));
          }}
          onPressFence={(id) => selectPlace(id === selectedPlaceId ? undefined : id)}
          fenceEdit={fenceEdit ?? undefined}
          onFenceGeometry={onFenceGeometry}
        />

        {/* top-left actions */}
        <View style={styles.topActions} pointerEvents="box-none">
          {fenceEdit ? (
            <>
              <View style={styles.editPill}>
                <Dot size={7} color={palette.accent} />
                <Txt variant="bodySemi" numberOfLines={1}>
                  {drawingMode
                    ? `Drawing a ${DRAW_MODES.find((m) => m.mode === drawingMode)?.label.toLowerCase()}`
                    : editingId === DRAFT_ID
                      ? 'New place'
                      : `Editing ${places.find((p) => p.id === editingId)?.name ?? 'place'}`}
                </Txt>
                {updateGeometry.isPending ? (
                  <Mono size={size.monoTiny} color={color.textFaint}>
                    saving…
                  </Mono>
                ) : null}
              </View>
              <Button
                label={drawingMode || editingId === DRAFT_ID ? 'Cancel' : 'Done'}
                variant={drawingMode || editingId === DRAFT_ID ? 'secondary' : 'primary'}
                icon={drawingMode || editingId === DRAFT_ID ? 'close' : 'check'}
                onPress={stopEditing}
                small={isPhone}
              />
            </>
          ) : (
            <>
              <Button
                label="Draw"
                icon={drawMenu ? 'chevron-up' : 'plus'}
                onPress={() => setDrawMenu((open) => !open)}
                small={isPhone}
              />
              <Button
                label="Share location"
                variant="secondary"
                onPress={() => router.push('/sharing')}
                small={isPhone}
              />
            </>
          )}
        </View>

        {followed && followName ? (
          <View style={[styles.followChip, (drawMenu || fenceEdit || selectedPlace) ? styles.followChipLow : null]}>
            <Dot size={8} color={followed.color ?? palette.accent} pulse />
            <Txt variant="small" color={color.textBody}>
              Following <Txt variant="bodySemi">{followName}</Txt>
            </Txt>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop following ${followName}`}
              onPress={() => setFollowKey(undefined)}
              hitSlop={8}
              style={styles.followStop}
            >
              <Icon name="close" size={14} color={color.textMuted} />
            </Pressable>
          </View>
        ) : null}

        {drawMenu && !fenceEdit ? (
          <View style={styles.drawMenu} accessibilityRole="menu">
            <Txt variant="micro" color={color.textFaint}>
              Draw a geofence as a
            </Txt>
            <View style={styles.drawMenuRow}>
              {DRAW_MODES.map(({ mode, label }) => (
                <Pressable
                  key={mode}
                  accessibilityRole="menuitem"
                  onPress={() => {
                    setDrawMenu(false);
                    selectPlace(undefined);
                    setFenceEdit(mode === 'draw-polygon' ? { mode, vertices: [] } : { mode });
                  }}
                  style={({ pressed }) => [styles.drawOption, pressed && styles.drawOptionPressed]}
                >
                  <ShapeGlyph mode={mode} />
                  <Txt variant="bodyMedium">{label}</Txt>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {selectedPlace && !fenceEdit && !drawMenu ? (
          <View style={styles.placeCard}>
            <View style={styles.placeCardText}>
              <Txt variant="bodySemi" numberOfLines={1}>
                {selectedPlace.name}
              </Txt>
              <Mono size={size.monoXs} color={color.textMuted}>
                {selectedPlace.shape === 'polygon' && selectedPlace.polygon.length >= 3
                  ? `polygon · ${selectedPlace.polygon.length} corners`
                  : `circle · ${formatMetres(selectedPlace.radiusM)}`}
              </Mono>
            </View>
            <Button label="Edit shape" variant="secondary" small onPress={() => startEdit(selectedPlace)} />
            <IconButton
              name="close"
              accessibilityLabel="Deselect place"
              onPress={() => selectPlace(undefined)}
              style={styles.placeCardClose}
            />
          </View>
        ) : null}

        {/* Map controls sit above the phone's pull-up handle, which otherwise
            covers the recentre button. */}
        <View style={[styles.controls, !isDesktop && styles.controlsPhone]} pointerEvents="box-none">
          {/* Airgap draws the local basemap only, so there is nothing to choose. */}
          {!offline ? <BasemapPicker value={basemap} onChange={setBasemap} /> : null}
          <View style={styles.zoomStack}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zoom in"
              onPress={() => requestZoom(Math.min(20, viewZoom + 1))}
              style={[styles.zoomButton, styles.zoomButtonTop]}
            >
              <Icon name="plus" size={16} color={color.textBody} strokeWidth={2} />
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Zoom out"
              onPress={() => requestZoom(Math.max(2, viewZoom - 1))}
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
              setFollowKey(undefined);
              selectDevice(undefined);
              setFitCenter(null);
              setEditFocus(null); // stop looking at the fence being edited
              setFittedKey(null); // pressing "locate me" asks for the fit again
              setCrowdFramed(false);
              setFocusPoint(null);
              requestZoom(viewZoom); // the fit, if there is one, overrides it
              setRecenterKey((k) => k + 1);
            }}
          />
        </View>

        {/* attribution: a licence requirement for OSM-derived tiles */}
        <View style={[styles.attribution, !isDesktop && styles.attributionPhone]} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            {attribution(basemap, {
              serverStyleUrl: data?.server.mapStyleUrl,
              provider: data?.server.mapProvider,
              offline: !!offline,
            })}
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
        {/* While editing, the editor's own toolbar owns the bottom of the map. */}
        {!isDesktop && !fenceEdit ? (
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

      <Sheet visible={draft !== null} onClose={stopEditing} title="New place" phone={isPhone}>
        {draft ? (
          <>
            <Txt variant="small" color={color.textMuted}>
              {draft.shape === 'circle' ? (
                <>
                  Circle of {formatMetres(draft.radiusM)} at{' '}
                  <Mono size={size.monoSm} color={color.textBody}>
                    {draft.center.lat.toFixed(5)}, {draft.center.lon.toFixed(5)}
                  </Mono>
                </>
              ) : (
                `Polygon with ${draft.polygon.length} corners`
              )}
            </Txt>
            <PlaceForm
              geometry={draft}
              submitting={createPlace.isPending}
              error={createPlace.error instanceof Error ? createPlace.error.message : undefined}
              onCancel={stopEditing}
              onSubmit={(values) => {
                createPlace.mutate(values, {
                  onSuccess: ({ place }) => {
                    stopEditing();
                    selectPlace(place.id);
                  },
                });
              }}
            />
          </>
        ) : null}
      </Sheet>
    </View>
  );
}

/** ShapeGlyph is the small picture on each draw option. */
function ShapeGlyph({ mode }: { mode: DrawMode }) {
  const stroke = palette.accent;
  return (
    <Svg width={22} height={22} viewBox="0 0 22 22">
      {mode === 'draw-circle' ? (
        <Circle cx={11} cy={11} r={8} fill="rgba(32,160,123,0.14)" stroke={stroke} strokeWidth={1.8} />
      ) : mode === 'draw-polygon' ? (
        <Path
          d="M4 6 L15 3 L19 13 L9 19 Z"
          fill="rgba(32,160,123,0.14)"
          stroke={stroke}
          strokeWidth={1.8}
          strokeLinejoin="round"
        />
      ) : (
        <Path
          d="M5 9 C4 4 12 2 16 5 C20 8 19 14 15 17 C11 20 5 18 4 14"
          fill="none"
          stroke={stroke}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      )}
    </Svg>
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
  editPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    maxWidth: 260,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.lg,
    paddingHorizontal: 12,
    paddingVertical: 8,
    ...shadow('button'),
  },
  drawMenu: {
    position: 'absolute',
    top: 64,
    left: 16,
    gap: 8,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    padding: 10,
    ...shadow('card'),
  },
  drawMenuRow: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  drawOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    minHeight: 40,
    paddingHorizontal: 12,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceMuted,
  },
  drawOptionPressed: { backgroundColor: color.accentSoft },
  placeCard: {
    position: 'absolute',
    top: 64,
    left: 16,
    maxWidth: 420,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.card,
    paddingVertical: 8,
    paddingLeft: 14,
    paddingRight: 8,
    ...shadow('card'),
  },
  placeCardText: { flexShrink: 1, gap: 2 },
  placeCardClose: { width: 32, height: 32 },

  followChip: {
    position: 'absolute',
    top: 62,
    left: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.surface,
    borderWidth: 1,
    borderColor: color.border,
    borderRadius: radius.md,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 5,
    ...shadow('float'),
  },
  followChipLow: { top: 124 },
  followStop: { padding: 4, borderRadius: radius.sm },

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

  attribution: {
    position: 'absolute',
    left: 10,
    bottom: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.78)',
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
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
