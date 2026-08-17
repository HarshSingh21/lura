import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError } from '@/api/client';
import { usePublicShare } from '@/api/hooks';
import { connectLive, type LiveStatus } from '@/api/live';
import type { Point, Position } from '@/api/types';
import { MapView } from '@/components/map/MapView';
import type { MapMarker } from '@/components/map/types';
import { Card, Dot } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, shadow, size, space } from '@/theme/tokens';

/**
 * The recipient's view of a share link.
 *
 * This is what "no account needed to view" means in practice (HLD §5.8): a token
 * in the URL, a read-only socket, a dot on a map, and nothing else. It renders
 * outside the app shell on purpose — no sidebar, no places, no notes, nothing that
 * would suggest the viewer has a workspace.
 *
 * When the share ends (revoked, expired, or the sharer arrived), the server drops
 * the subscription and this screen says so plainly rather than freezing on a stale
 * position, which would be the dishonest failure mode.
 */
export default function ShareViewer() {
  const { token } = useLocalSearchParams<{ token: string }>();
  const shareToken = typeof token === 'string' ? token : '';
  const { data, error, isLoading, refetch } = usePublicShare(shareToken);

  const [live, setLive] = useState<Record<string, Position>>({});
  const [status, setStatus] = useState<LiveStatus>('idle');
  const [ended, setEnded] = useState<string | null>(null);

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

  const devices = data?.devices ?? [];

  const markers = useMemo<MapMarker[]>(
    () =>
      devices
        .map((device): MapMarker | null => {
          const point = live[device.id]?.point ?? device.point;
          if (!point) return null;
          const speed = live[device.id]?.speedMps ?? device.speedMps ?? 0;
          return {
            id: device.id,
            point,
            label: speed > 1 ? `${device.name} · ${Math.round(speed * 3.6)} km/h` : device.name,
            tone: 'accent' as const,
            pulse: !ended && speed > 1,
          };
        })
        .filter((m) => m !== null),
    [devices, live, ended],
  );

  const center = useMemo<Point>(() => {
    const first = markers[0]?.point;
    return first ?? { lat: 12.9716, lon: 77.5946 };
  }, [markers]);

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
        <MapView center={center} zoom={14} markers={markers} recenterKey={markers.length} />

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
          <Card style={styles.info}>
            <Txt variant="cardTitle">{data.sharerName}</Txt>
            <Txt variant="tiny" color={color.textMuted}>
              {describeEnding(data.mode, data.expiresAt, data.arrivePlaceName)}
            </Txt>
            {markers.length === 0 ? (
              <Txt variant="tiny" color={palette.amberInk} style={styles.noFix}>
                No position yet — waiting for the next fix.
              </Txt>
            ) : (
              <Mono size={size.monoXs} color={color.textFaint} style={styles.noFix}>
                {devices.length} {devices.length === 1 ? 'device' : 'devices'} shared
              </Mono>
            )}
          </Card>
        ) : null}

        <View style={styles.footer} pointerEvents="none">
          <Mono size={size.monoTiny} color={color.textSubtle}>
            Read-only · no account · the sharer can revoke this at any time
          </Mono>
        </View>
      </View>
    </SafeAreaView>
  );
}

function describeEnding(mode: string, expiresAt?: string, arrivePlace?: string): string {
  switch (mode) {
    case 'until_arrive':
      return arrivePlace ? `Sharing until they arrive at ${arrivePlace}` : 'Sharing until they arrive';
    case 'duration':
      return expiresAt
        ? `Sharing until ${new Date(expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
        : 'Sharing for a limited time';
    default:
      return 'Sharing until they revoke the link';
  }
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

  info: {
    position: 'absolute',
    left: space.xl,
    top: space.xl,
    gap: 3,
    maxWidth: 320,
    ...shadow('card'),
  },
  noFix: { marginTop: 4 },

  footer: { position: 'absolute', left: space.xl, bottom: space.xl },
});
