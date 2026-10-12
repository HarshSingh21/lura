import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Device, Note, Place, Position, Share } from '@/api/types';
import { Button, Card, Dot, EmptyState, TriggerBadge, styles as ui } from '@/components/ui/primitives';
import { joinNames, latestFix, watchers } from '@/features/people/peer';
import type { Peer } from '@/features/people/types';
import type { TrackingStatus } from '@/hooks/useTracking';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';

import { formatAge, formatSpeed, MOVING_MPS, speedOf, type TrailPoint } from './motion';

/**
 * The live rail: what is sharing, who can see me, what is moving, what is about
 * to fire.
 *
 * These blocks answer the questions the live map cannot: who can see me, where
 * are my devices, and what will happen next. The two sharing blocks — links and
 * people — are first and loudest on purpose: HLD §11 requires an always-on
 * indicator, not a status buried below a device list.
 */

/**
 * useNow ticks a clock for "3s ago" labels.
 *
 * Only the rail subscribes, so the once-a-second re-render is a handful of rows,
 * never the map.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Follow keys name a person ("user:<id>") or one of my devices ("device:<id>"). */
export type FollowKey = `user:${string}` | `device:${string}`;

/** FollowButton is the per-row "keep the camera on them" toggle. */
function FollowButton({ on, name, onPress }: { on: boolean; name: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="switch"
      aria-checked={on}
      accessibilityLabel={on ? `Stop following ${name}` : `Follow ${name} on the map`}
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [styles.follow, on ? styles.followOn : null, pressed ? ui.pressed : null]}
    >
      <Mono size={size.monoTiny} medium color={on ? '#ffffff' : color.textMuted}>
        {on ? 'FOLLOWING' : 'FOLLOW'}
      </Mono>
    </Pressable>
  );
}

/**
 * pingLine writes the live half of a row: speed or "still", how long since the
 * last ping (ticking), and the battery when the device reported one.
 */
function pingLine({ speed, lastSeenMs, battery, now }: { speed: number; lastSeenMs?: number; battery?: number; now: number }): string {
  const parts: string[] = [];
  parts.push(speed > MOVING_MPS ? `Moving · ${formatSpeed(speed)}` : 'Still');
  if (lastSeenMs !== undefined && Number.isFinite(lastSeenMs)) parts.push(formatAge(now - lastSeenMs));
  if (battery !== undefined && battery > 0) parts.push(`${Math.round(battery)}% battery`);
  return parts.join(' · ');
}

export function SharingBanner({
  shares,
  places,
  onStop,
  stopping,
}: {
  shares: Share[];
  places: Place[];
  onStop: (id: string) => void;
  stopping?: boolean;
}) {
  if (shares.length === 0) return null;
  const share = shares[0];
  if (!share) return null;

  const placeName = places.find((p) => p.id === share.arrivePlaceId)?.name;

  return (
    <View style={styles.sharingCard}>
      <View style={styles.sharingHead}>
        <Dot size={8} color={palette.amberDot} blink />
        <Txt variant="bodySemi" color={palette.amberInk}>
          You&apos;re sharing your location
        </Txt>
      </View>

      <Txt variant="label" color={color.textMuted} style={styles.sharingDetail}>
        To <Txt variant="bodySemi">{share.label}</Txt>
        {share.mode === 'until_arrive' && placeName ? (
          <>
            {' · until you arrive '}
            <Txt variant="bodySemi">{placeName}</Txt>
          </>
        ) : share.mode === 'duration' && share.expiresAt ? (
          <>{` · until ${formatClock(share.expiresAt)}`}</>
        ) : (
          ' · until you revoke it'
        )}
      </Txt>

      {shares.length > 1 ? (
        <Mono size={size.monoXs} color={palette.amberInk} style={styles.sharingMore}>
          + {shares.length - 1} more active {shares.length === 2 ? 'link' : 'links'}
        </Mono>
      ) : null}

      <Button
        label="Stop sharing"
        variant="secondary"
        full
        loading={stopping}
        onPress={() => onStop(share.id)}
        style={styles.stopButton}
      />
    </View>
  );
}

/**
 * PeopleList is the rail's account-to-account sharing block.
 *
 * It leads with the indicator rather than the list, because the two questions are
 * not equally urgent: whom I can see is useful, and who can see *me* is the one
 * HLD §11 says must never be discoverable only by going looking. Every row then
 * carries both directions — an inbound line and a small outbound tag — so a peer
 * who has paused their side can never look like a peer I have paused mine for.
 */
export function PeopleList({
  people,
  positions,
  onManage,
  trails = {},
  colors = {},
  followKey,
  onFollow,
}: {
  people: Peer[];
  positions: Record<string, Position>;
  onManage?: () => void;
  /** Recent fixes per device id, for speed and ping age. */
  trails?: Record<string, TrailPoint[]>;
  /** Marker colour per peer user id, so a row and its marker read as one person. */
  colors?: Record<string, string>;
  followKey?: FollowKey;
  onFollow?: (key: FollowKey | undefined) => void;
}) {
  const now = useNow();
  const seenBy = watchers(people);
  const accepted = people.filter((p) => p.status === 'accepted');
  const incoming = people.filter((p) => p.status === 'pending_in');
  const watched = seenBy.length > 0;

  return (
    <View>
      <SectionLabel>PEOPLE</SectionLabel>

      <View style={[styles.watchers, watched ? styles.watchersOn : styles.watchersOff]}>
        <View style={styles.watchersHead}>
          <Dot size={8} color={watched ? palette.amberDot : color.neutralDot} blink={watched} />
          <Txt variant="bodySemi" color={watched ? palette.amberInk : color.textMuted}>
            {watched
              ? `${seenBy.length} ${seenBy.length === 1 ? 'person' : 'people'} can see you`
              : 'No one can see you'}
          </Txt>
        </View>
        <Txt
          variant="micro"
          color={watched ? palette.amberInk : color.textFaint}
          style={styles.watchersNames}
        >
          {watched ? joinNames(seenBy) : 'No connected person is receiving your position.'}
        </Txt>
      </View>

      {incoming.length > 0 ? (
        <Pressable
          accessibilityRole={onManage ? 'button' : 'text'}
          accessibilityLabel={`${incoming.length} invitation${incoming.length === 1 ? '' : 's'} waiting for your answer`}
          onPress={onManage}
          style={({ pressed }) => [styles.invitePill, pressed && onManage ? ui.pressed : null]}
        >
          <Dot size={7} color={palette.accent} pulse />
          <Txt variant="micro" color={palette.accentInk}>
            {incoming.length} invitation{incoming.length === 1 ? '' : 's'} waiting for you
          </Txt>
        </Pressable>
      ) : null}

      <View style={styles.list}>
        {accepted.length === 0 ? (
          <EmptyState
            title="No one is connected"
            body="Invite someone in People and you will see each other live."
          />
        ) : (
          accepted.map((peer) => {
            const fix = peer.sharingWithMe ? latestFix(peer, positions) : undefined;
            const trail = fix ? trails[fix.deviceId] : undefined;
            const live = fix ? positions[fix.deviceId] : undefined;
            const tint = colors[peer.peerId] ?? palette.amber;
            const key: FollowKey = `user:${peer.peerId}`;
            const following = followKey === key;
            const name = peer.peerName || peer.peerEmail;
            return (
              <Card key={peer.id} padded={false} style={[styles.deviceCard, following ? styles.cardFollowing : null]}>
                <View style={styles.deviceRow}>
                  <View
                    style={[styles.deviceIcon, peer.sharingWithMe ? { backgroundColor: withAlpha(tint, 0.16) } : null]}
                  >
                    <Dot size={9} color={peer.sharingWithMe ? tint : color.neutralDot} pulse={!!fix && isFresh(fix.lastSeen, now)} />
                  </View>

                  <View style={ui.flex}>
                    <Txt variant="bodySemi" numberOfLines={1}>
                      {name}
                    </Txt>
                    <Txt variant="micro" color={color.textSubtle} numberOfLines={2}>
                      {fix
                        ? pingLine({
                            speed: trail && trail.length > 0 ? speedOf(trail) : fix.speedMps,
                            lastSeenMs: fix.lastSeen ? new Date(fix.lastSeen).getTime() : undefined,
                            battery: live?.battery,
                            now,
                          })
                        : describePeer(peer)}
                    </Txt>
                  </View>

                  {fix && onFollow ? (
                    <FollowButton on={following} name={name} onPress={() => onFollow(following ? undefined : key)} />
                  ) : null}

                  <View style={[styles.peerTag, peer.watchingMe ? styles.peerTagOn : null]}>
                    <Mono
                      size={size.monoTiny}
                      medium
                      color={peer.watchingMe ? palette.amberInk : color.textFaint}
                    >
                      {peer.watchingMe ? 'SEES YOU' : 'PAUSED'}
                    </Mono>
                  </View>
                </View>
              </Card>
            );
          })
        )}
      </View>

      {onManage ? (
        <Button
          label="Manage people"
          variant="secondary"
          small
          full
          onPress={onManage}
          style={styles.manageButton}
        />
      ) : null}
    </View>
  );
}

/** describePeer writes the inbound half of a peer row when there is no fix to describe. */
function describePeer(peer: Peer): string {
  if (!peer.sharingWithMe) return 'Not sharing with you';
  return 'Sharing · no fix yet';
}

/** A ping within the last two minutes counts as live for the pulsing dot. */
function isFresh(iso: string | undefined, now: number): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && now - t < 120_000;
}

function withAlpha(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function DeviceList({
  devices,
  positions,
  places,
  onSelect,
  trails = {},
  followKey,
  onFollow,
}: {
  devices: Device[];
  positions: Record<string, Position>;
  places: Place[];
  onSelect?: (id: string) => void;
  trails?: Record<string, TrailPoint[]>;
  followKey?: FollowKey;
  onFollow?: (key: FollowKey | undefined) => void;
}) {
  const now = useNow();
  return (
    <View>
      <SectionLabel>MY DEVICES</SectionLabel>
      <View style={styles.list}>
        {devices.length === 0 ? (
          <EmptyState title="No devices yet" body="Add one in Settings to start tracking." />
        ) : (
          devices.map((device) => {
            const live = positions[device.id];
            const trail = trails[device.id];
            const speed = trail && trail.length > 0 ? speedOf(trail) : (live?.speedMps ?? device.speedMps ?? 0);
            const moving = speed > MOVING_MPS;
            const lastSeen = live?.recvTs ?? device.lastSeen;
            const lastSeenMs = lastSeen ? new Date(lastSeen).getTime() : undefined;
            const key: FollowKey = `device:${device.id}`;
            const following = followKey === key;
            const hasFix = !!(live?.point ?? device.lastPoint);
            const battery = live?.battery || device.battery || 0;
            const inside = (device.insidePlaces ?? [])
              .map((id) => places.find((p) => p.id === id)?.name)
              .filter(Boolean)[0];

            return (
              <Card
                key={device.id}
                padded={false}
                style={[styles.deviceCard, following ? styles.cardFollowing : null]}
                onPress={onSelect ? () => onSelect(device.id) : undefined}
              >
                <View style={styles.deviceRow}>
                  <View style={[styles.deviceIcon, moving ? styles.deviceIconLive : null]}>
                    <Dot size={9} color={moving ? palette.accent : color.neutralDot} />
                  </View>

                  <View style={ui.flex}>
                    <Txt variant="bodySemi" numberOfLines={1}>
                      {device.name}
                    </Txt>
                    <Txt variant="micro" color={color.textSubtle} numberOfLines={2}>
                      {describeDevice({ moving, speed, inside, lastSeenMs, now })}
                    </Txt>
                  </View>

                  {battery > 0 ? (
                    <Mono size={size.monoSm} color={color.textMuted}>
                      {Math.round(battery)}%
                    </Mono>
                  ) : null}

                  {hasFix && onFollow ? (
                    <FollowButton on={following} name={device.name} onPress={() => onFollow(following ? undefined : key)} />
                  ) : null}
                </View>
              </Card>
            );
          })
        )}
      </View>
    </View>
  );
}

/** describeDevice writes the "Moving · 34 km/h · 3s ago" / "Idle · Home" line from the mock. */
function describeDevice({
  moving,
  speed,
  inside,
  lastSeenMs,
  now,
}: {
  moving: boolean;
  speed: number;
  inside?: string;
  lastSeenMs?: number;
  now: number;
}): string {
  const age = lastSeenMs !== undefined && Number.isFinite(lastSeenMs) ? ` · ${formatAge(now - lastSeenMs)}` : '';
  if (moving) return `Moving · ${formatSpeed(speed)}${age}`;
  if (inside) return `Idle · ${inside}${age}`;
  if (age) return `Idle${age}`;
  return 'No fix yet';
}

export function UpcomingReminders({ notes, places }: { notes: Note[]; places: Place[] }) {
  // "Upcoming" is an open note bound to a place: it is armed and waiting for the
  // geofence to fire. A note with no place cannot fire, so it is not upcoming.
  const upcoming = notes.filter((note) => !note.done && note.placeId).slice(0, 6);

  return (
    <View>
      <SectionLabel>UPCOMING REMINDERS</SectionLabel>
      <View style={styles.list}>
        {upcoming.length === 0 ? (
          <EmptyState title="Nothing armed" body="Write a note and Lura will bind it to a place." />
        ) : (
          upcoming.map((note) => {
            const place = places.find((p) => p.id === note.placeId);
            return (
              <Card key={note.id} style={styles.reminderCard}>
                <View style={styles.reminderHead}>
                  <TriggerBadge trigger={note.trigger} />
                  {note.tags[0] ? (
                    <Mono size={size.monoXs} color={color.textFaint}>
                      {note.tags[0]}
                    </Mono>
                  ) : null}
                </View>
                <Txt variant="bodyMedium" numberOfLines={2}>
                  {note.text}
                </Txt>
                <Txt variant="tiny" color={color.textSubtle}>
                  at {place?.name ?? 'unbound place'}
                </Txt>
              </Card>
            );
          })
        )}
      </View>
    </View>
  );
}

/** DeviceTracking is the "publish this device's location" control (mobile-first). */
export function DeviceTracking({
  enabled,
  onToggle,
  deviceName,
  status,
}: {
  enabled: boolean;
  onToggle: () => void;
  deviceName?: string;
  /** This device's own GPS, from useTracking. */
  status?: TrackingStatus;
}) {
  return (
    <Card style={styles.trackingCard}>
      <View style={styles.trackingHead}>
        <Dot size={8} color={enabled ? palette.accent : color.timelineNode} pulse={enabled} />
        <Txt variant="bodySemi">{enabled ? 'Publishing this device' : 'This device is not publishing'}</Txt>
      </View>
      {enabled ? <GpsReadout status={status} /> : null}
      <Txt variant="tiny" color={color.textMuted}>
        {enabled
          ? `Foreground fixes are being sent as ${deviceName ?? 'this device'}. They stop when you leave the app — background tracking needs the mobile build.`
          : 'Send this device’s position to your Lura server while the app is open.'}
      </Txt>
      <Button
        label={enabled ? 'Stop publishing' : 'Publish my location'}
        variant={enabled ? 'secondary' : 'primary'}
        full
        onPress={onToggle}
        style={styles.trackingButton}
      />
    </Card>
  );
}

/**
 * GpsReadout shows how good this device's own fix is — the number that decides
 * how accurately everyone else sees you — and whether the latest fix was held
 * back as too rough to send.
 */
function GpsReadout({ status }: { status?: TrackingStatus }) {
  const now = useNow();
  const acc = status?.accuracyM;
  if (acc === undefined || !Number.isFinite(acc)) {
    return (
      <Mono size={size.monoXs} color={color.textFaint}>
        GPS · waiting for a fix…
      </Mono>
    );
  }
  const quality = acc <= 20 ? 'good' : acc <= 100 ? 'fair' : 'poor';
  const tint = quality === 'good' ? palette.accentDark : quality === 'fair' ? palette.amberDark : palette.danger;
  const held = status?.held === 'inaccurate' ? ' · too rough to send' : '';
  return (
    <View style={styles.gpsRow} accessibilityLabel={`GPS accuracy plus or minus ${Math.round(acc)} metres, ${quality}`}>
      <Dot size={6} color={tint} />
      <Mono size={size.monoXs} color={tint}>
        GPS ±{Math.round(acc)} m · {quality}
        {held}
      </Mono>
      {status?.lastSentAt ? (
        <Mono size={size.monoXs} color={color.textFaint}>
          sent {formatAge(now - status.lastSentAt)}
        </Mono>
      ) : null}
    </View>
  );
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

const styles = StyleSheet.create({
  list: { gap: space.md },

  sharingCard: {
    backgroundColor: color.amberSoft,
    borderWidth: 1,
    borderColor: color.amberBorder,
    borderRadius: radius.cardLg - 1,
    padding: space.xl,
  },
  sharingHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8 },
  sharingDetail: { lineHeight: 18 },
  sharingMore: { marginTop: 6 },
  stopButton: { marginTop: 11, borderColor: color.amberBorderStrong },

  watchers: {
    borderWidth: 1,
    borderRadius: radius.card,
    paddingVertical: 11,
    paddingHorizontal: 13,
    marginBottom: space.md,
  },
  watchersOn: { backgroundColor: color.amberSoft, borderColor: color.amberBorder },
  watchersOff: { backgroundColor: color.surfaceMuted, borderColor: color.hairlineSoft },
  watchersHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  watchersNames: { marginTop: 4, lineHeight: 15 },

  invitePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    alignSelf: 'flex-start',
    backgroundColor: color.accentSoft,
    borderRadius: radius.md,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginBottom: space.md,
  },
  peerTag: {
    borderRadius: radius.sm,
    backgroundColor: color.neutralChip,
    paddingVertical: 3,
    paddingHorizontal: 6,
  },
  peerTagOn: { backgroundColor: color.amberTagBg },
  manageButton: { marginTop: space.md },

  deviceCard: { padding: 11 },
  deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  deviceIcon: {
    width: 34,
    height: 34,
    borderRadius: 9,
    backgroundColor: color.neutralChip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceIconLive: { backgroundColor: color.accentFence },

  reminderCard: { padding: 12, gap: 4 },
  reminderHead: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2 },

  trackingCard: { gap: 6 },
  gpsRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  follow: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    paddingVertical: 4,
    paddingHorizontal: 7,
  },
  followOn: { backgroundColor: palette.accentDark, borderColor: palette.accentDark },
  cardFollowing: { borderColor: palette.accent },
  trackingHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trackingButton: { marginTop: 6 },
});
