import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { usePublicShare } from '@/api/hooks';
import { connectLive, type LiveStatus } from '@/api/live';
import type { Point, Position } from '@/api/types';
import { zoomToInclude, type Box } from '@/components/map/fit';
import { MapView } from '@/components/map/MapView';
import type { MapMarker } from '@/components/map/types';
import { Card, Dot } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, shadow, size, space } from '@/theme/tokens';
import { useLayoutMode } from '@/theme/useLayout';

/**
 * The recipient's view of a share link.
 *
 * This is what "no account needed to view" means in practice (HLD §5.8): a token
 * in the URL, a read-only socket, a dot on a map, and nothing else. It renders
 * outside the app shell on purpose — no sidebar, no places, no notes, nothing that
 * would suggest the viewer has a workspace.
 *
 * Three things this screen has to get right, because the recipient has no other
 * way to find out:
 *
 *   - **A real basemap.** The snapshot carries the style URL for exactly this
 *     reason. Without one, MapLibre renders a plain background and the recipient
 *     sees two labels floating on grey — technically the position, practically
 *     nothing.
 *   - **Everyone in frame.** Someone sharing two devices a few kilometres apart
 *     must not have one of them off the edge, so the zoom is fitted to the points
 *     rather than fixed.
 *   - **When it ends.** A link that stops working without saying so is the
 *     dishonest failure mode; the panel counts down, and a revoke is announced.
 */
export default function ShareViewer() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const shareToken = typeof token === 'string' ? token : '';
  const { data, error, isLoading, refetch } = usePublicShare(shareToken);
  const { isPhone } = useLayoutMode();

  const [live, setLive] = useState<Record<string, Position>>({});
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [ended, setEnded] = useState<string | null>(null);
  const [box, setBox] = useState<Box>({ width: 0, height: 0 });
  // Re-rendered on a slow tick so "ends in 12 min" and "seen 3 min ago" stay true
  // on a screen nobody is interacting with.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shareToken) return;
    const conn = connectLive({
      path: `/s/${shareToken}/ws`,
      anonymous: true,
      onStatus: setStatus,
      onFrame: (frame) => {
        switch (frame.type) {
          case 'position':
            setLive((prev) => ({ ...prev, [frame.data.deviceId]: frame.data }));
            break;
          case 'acl':
            // The share was revoked or expired: stop claiming to be live and
            // re-read the snapshot so the reason is authoritative.
            if (frame.data.action === 'revoke') {
              setEnded(frame.data.reason || 'This link is no longer active.');
              void refetch();
            }
            break;
          default:
            break;
        }
      },
    });
    return () => conn.close();
  }, [shareToken, refetch]);

  const devices = useMemo(() => data?.devices ?? [], [data]);

  /** Each shared device, merged with anything the socket has since delivered. */
  const fixes = useMemo(
    () =>
      devices
        .map((device) => {
          const frame = live[device.id];
          const point = frame?.point ?? device.point;
          if (!point) return null;
          const speedMps = frame?.speedMps ?? device.speedMps ?? 0;
          return {
            id: device.id,
            name: device.name,
            point,
            speedMps,
            lastSeen: frame?.recvTs ?? device.lastSeen,
          };
        })
        .filter((fix) => fix !== null)
        .sort((a, b) => stamp(b.lastSeen) - stamp(a.lastSeen)),
    [devices, live],
  );

  const markers = useMemo<MapMarker[]>(
    () =>
      fixes.map((fix) => ({
        id: fix.id,
        point: fix.point,
        label: fix.speedMps > 1 ? `${fix.name} · ${Math.round(fix.speedMps * 3.6)} km/h` : fix.name,
        tone: 'accent' as const,
        pulse: !ended && fix.speedMps > 1,
      })),
    [fixes, ended],
  );

  /** The centre is the middle of everything shared, so nothing sits at an edge. */
  const center = useMemo<Point>(() => {
    if (fixes.length === 0) return FALLBACK_CENTER;
    const lat = fixes.reduce((sum, fix) => sum + fix.point.lat, 0) / fixes.length;
    const lon = fixes.reduce((sum, fix) => sum + fix.point.lon, 0) / fixes.length;
    return { lat, lon };
  }, [fixes]);

  // Fitted during render rather than in an effect, so the map is never painted
  // once at the wrong zoom and then again at the right one.
  const [zoom, setZoom] = useState(15);
  const [fittedKey, setFittedKey] = useState<string | null>(null);
  const markerKey = useMemo(() => markers.map((m) => m.id).join(','), [markers]);
  if (fittedKey !== markerKey) {
    const fitted = zoomToInclude(
      center,
      markers.map((m) => m.point),
      box,
      // The panel floats over the map, so the fit has to clear it: on a phone it
      // spans the width along the bottom, on a desktop it is a card in the
      // top-left corner.
      isPhone
        ? { top: 56, right: 40, bottom: 340, left: 40 }
        : { top: 60, right: 80, bottom: 90, left: 350 },
    );
    if (fitted !== undefined) {
      setFittedKey(markerKey);
      setZoom(Math.min(16, Math.floor(fitted * 10) / 10));
    }
  }

  // A phone screen is mostly map; a list of every device would cover it. The
  // markers are all still drawn — the panel is a summary, not the source.
  const shown = isPhone ? fixes.slice(0, 3) : fixes;
  const hidden = fixes.length - shown.length;

  const gone =
    ended !== null || (error instanceof ApiError && (error.status === 403 || error.status === 404));

  return (
    <SafeAreaView style={styles.root}>
      <View style={styles.header}>
        <View style={styles.brand}>
          <View style={styles.logo}>
            <View style={styles.logoCore} />
          </View>
          <Txt variant="bodySemi">Lura</Txt>
          <Mono size={size.monoTiny} color={color.textFaint}>
            shared view
          </Mono>
        </View>
        {!gone && data ? (
          <View style={styles.liveTag}>
            <Dot size={7} color={status === 'open' ? palette.accent : palette.amber} blink={status !== 'open'} />
            <Mono size={size.monoXs} color={color.textMuted}>
              {status === 'open' ? 'live' : 'reconnecting'}
            </Mono>
          </View>
        ) : null}
      </View>

      <View style={styles.mapWrap}>
        <MapView
          center={center}
          zoom={zoom}
          markers={markers}
          styleUrl={data?.map?.styleUrl}
          offline={data?.map?.airgap}
          recenterKey={markers.length}
          onViewportChange={(v) =>
            setBox((prev) => (prev.width === v.width && prev.height === v.height ? prev : { width: v.width, height: v.height }))
          }
        />

        {gone ? (
          <View style={styles.overlay}>
            <Card style={styles.notice}>
              <Txt variant="h2">This share has ended</Txt>
              <Txt variant="small" color={color.textMuted} style={styles.noticeBody}>
                {ended ??
                  (error instanceof ApiError && error.status === 404
                    ? 'That link does not exist.'
                    : 'The link was revoked or expired. Ask for a new one if you still need it.')}
              </Txt>
            </Card>
          </View>
        ) : isLoading ? (
          <View style={styles.overlay}>
            <Card style={styles.notice}>
              <Txt variant="bodySemi">Opening the shared view…</Txt>
            </Card>
          </View>
        ) : data ? (
          <Card style={[styles.panel, isPhone ? styles.panelPhone : styles.panelDesktop]}>
            <View style={styles.who}>
              <View style={styles.avatar}>
                <Txt variant="small" color={palette.accentInk}>
                  {initials(data.sharerName)}
                </Txt>
              </View>
              <View style={styles.whoText}>
                <Txt variant="cardTitle">{data.sharerName}</Txt>
                <Txt variant="tiny" color={color.textMuted}>
                  {describeEnding(data.mode, data.expiresAt, data.arrivePlaceName, now)}
                </Txt>
              </View>
            </View>

            {fixes.length === 0 ? (
              <View style={styles.waiting}>
                <Dot size={7} color={palette.amber} blink />
                <Txt variant="tiny" color={palette.amberInk} style={styles.waitingText}>
                  No position yet — the map will move as soon as a fix arrives.
                </Txt>
              </View>
            ) : (
              <View style={styles.devices}>
                {shown.map((fix) => (
                  <View key={fix.id} style={styles.deviceRow}>
                    <Dot size={7} color={fix.speedMps > 1 ? palette.accent : color.textFaint} />
                    <View style={styles.deviceText}>
                      <Txt variant="small">{fix.name}</Txt>
                      <Mono size={size.monoXs} color={color.textFaint}>
                        {fix.speedMps > 1 ? `moving ${Math.round(fix.speedMps * 3.6)} km/h · ` : ''}
                        {describeSeen(fix.lastSeen, now)}
                      </Mono>
                    </View>
                  </View>
                ))}
                {hidden > 0 ? (
                  <Mono size={size.monoXs} color={color.textFaint}>
                    + {hidden} more {hidden === 1 ? 'device' : 'devices'}, all on the map
                  </Mono>
                ) : null}
              </View>
            )}

            {isPhone ? (
              <Mono size={size.monoTiny} color={color.textSubtle} style={styles.panelNote}>
                {READ_ONLY_NOTE}
              </Mono>
            ) : null}
          </Card>
        ) : null}

        {/* On a phone the same sentence rides at the bottom of the panel; a second
            floating chip would just be one more thing covering the map. */}
        {isPhone ? null : (
          <View style={styles.footer} pointerEvents="none">
            <Mono size={size.monoTiny} color={color.textMuted}>
              {READ_ONLY_NOTE}
            </Mono>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

/** The one sentence that explains what this page is, and what it is not. */
const READ_ONLY_NOTE = 'Read-only · no account · the sharer can revoke this at any time';

/** Bengaluru, only ever seen before the first fix arrives. */
const FALLBACK_CENTER: Point = { lat: 12.9716, lon: 77.5946 };

function stamp(iso?: string): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** initials keeps the avatar to two letters, whatever the name looks like. */
function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
}

/**
 * describeEnding says how the share ends, counting down where it can.
 *
 * A wall-clock time ("until 3:19") is useless to someone who does not know what
 * time it is on the sharer's clock, so the remaining time leads and the clock time
 * follows it.
 */
function describeEnding(mode: string, expiresAt: string | undefined, arrivePlace: string | undefined, now: number): string {
  switch (mode) {
    case 'until_arrive':
      return arrivePlace ? `Sharing until they arrive at ${arrivePlace}` : 'Sharing until they arrive';
    case 'duration': {
      if (!expiresAt) return 'Sharing for a limited time';
      const at = new Date(expiresAt);
      const remainingMs = at.getTime() - now;
      const clock = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      if (remainingMs <= 0) return 'This link has expired';
      return `Ends in ${describeDuration(remainingMs)} · ${clock}`;
    }
    default:
      return 'Sharing until they revoke the link';
  }
}

function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** describeSeen turns a timestamp into the only thing that matters: how stale. */
function describeSeen(iso: string | undefined, now: number): string {
  const at = stamp(iso);
  if (at === 0) return 'no fix yet';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  return `seen ${describeDuration(seconds * 1000)} ago`;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: color.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.xxl,
    paddingVertical: space.xl,
    backgroundColor: color.surface,
    borderBottomWidth: 1,
    borderBottomColor: color.hairline,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  logo: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: palette.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoCore: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ffffff' },
  liveTag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: color.surfaceMuted,
    borderRadius: radius.md,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },

  mapWrap: { flex: 1, backgroundColor: color.mapBg },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xxl,
  },
  notice: { maxWidth: 420, gap: 6, ...shadow('card') },
  noticeBody: { lineHeight: 19 },

  // Position is split into two complete styles rather than one overridden with
  // `undefined`: setting both `top` and `bottom` stretches the card down the whole
  // screen, and that is exactly what an override that fails to erase produces.
  panel: { position: 'absolute', gap: 12, ...shadow('card') },
  panelDesktop: { left: space.xl, top: space.xl, width: 290 },
  /**
   * On a phone the panel spans the width along the *bottom*, not the top: 290 dp
   * of card on a 360 dp screen is neither a panel nor out of the way, and the rest
   * of the product already puts its summary behind a bottom sheet, so this is
   * where a thumb expects it.
   */
  panelPhone: { left: space.md, right: space.md, bottom: space.xl },
  panelNote: { borderTopWidth: 1, borderTopColor: color.hairlineSoft, paddingTop: 9 },

  who: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 12,
    backgroundColor: color.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  whoText: { flex: 1, gap: 2 },

  waiting: { flexDirection: 'row', alignItems: 'flex-start', gap: 7 },
  waitingText: { flex: 1, lineHeight: 16 },

  devices: { gap: 9, borderTopWidth: 1, borderTopColor: color.hairlineSoft, paddingTop: 10 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deviceText: { flex: 1, gap: 1 },

  // Over a basemap, unbacked text competes with street labels and loses. The chip
  // is what makes the one sentence explaining this page legible at all.
  footer: {
    position: 'absolute',
    left: space.xl,
    bottom: space.xl,
    backgroundColor: color.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.hairlineSoft,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
});
