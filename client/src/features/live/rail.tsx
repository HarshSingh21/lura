import { Pressable, StyleSheet, View } from 'react-native';

import type { Device, Note, Place, Position, Share } from '@/api/types';
import { Button, Card, Dot, EmptyState, TriggerBadge, styles as ui } from '@/components/ui/primitives';
import { joinNames, latestFix, watchers } from '@/features/people/peer';
import type { Peer } from '@/features/people/types';
import { Mono, SectionLabel, Txt } from '@/theme/text';
import { color, font, palette, radius, size, space } from '@/theme/tokens';

/**
 * The live rail: what is sharing, who can see me, what is moving, what is about
 * to fire.
 *
 * These blocks answer the questions the live map cannot: who can see me, where
 * are my devices, and what will happen next. The two sharing blocks — links and
 * people — are first and loudest on purpose: HLD §11 requires an always-on
 * indicator, not a status buried below a device list.
 */

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
}: {
  people: Peer[];
  positions: Record<string, Position>;
  onManage?: () => void;
}) {
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
            return (
              <Card key={peer.id} padded={false} style={styles.deviceCard}>
                <View style={styles.deviceRow}>
                  <View style={[styles.deviceIcon, peer.sharingWithMe ? styles.deviceIconLive : null]}>
                    <Dot size={9} color={peer.sharingWithMe ? palette.accent : color.neutralDot} />
                  </View>

                  <View style={ui.flex}>
                    <Txt variant="bodySemi" numberOfLines={1}>
                      {peer.peerName || peer.peerEmail}
                    </Txt>
                    <Txt variant="micro" color={color.textSubtle} numberOfLines={1}>
                      {describePeer(peer, fix?.moving ?? false, fix?.speedMps ?? 0, fix?.lastSeen)}
                    </Txt>
                  </View>

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

/** describePeer writes the inbound half of a peer row: what *they* let me see. */
function describePeer(peer: Peer, moving: boolean, speed: number, lastSeen?: string): string {
  if (!peer.sharingWithMe) return 'Not sharing with you';
  if (moving) return `Moving · ${Math.round(speed * 3.6)} km/h`;
  if (lastSeen) return `Sharing · seen ${formatRelative(lastSeen)}`;
  return 'Sharing · no fix yet';
}

export function DeviceList({
  devices,
  positions,
  places,
  onSelect,
}: {
  devices: Device[];
  positions: Record<string, Position>;
  places: Place[];
  onSelect?: (id: string) => void;
}) {
  return (
    <View>
      <SectionLabel>MY DEVICES</SectionLabel>
      <View style={styles.list}>
        {devices.length === 0 ? (
          <EmptyState title="No devices yet" body="Add one in Settings to start tracking." />
        ) : (
          devices.map((device) => {
            const live = positions[device.id];
            const speed = live?.speedMps ?? device.speedMps ?? 0;
            const moving = speed > 1;
            const inside = (device.insidePlaces ?? [])
              .map((id) => places.find((p) => p.id === id)?.name)
              .filter(Boolean)[0];

            return (
              <Card key={device.id} padded={false} style={styles.deviceCard} onPress={onSelect ? () => onSelect(device.id) : undefined}>
                <View style={styles.deviceRow}>
                  <View style={[styles.deviceIcon, moving ? styles.deviceIconLive : null]}>
                    <Dot size={9} color={moving ? palette.accent : color.neutralDot} />
                  </View>

                  <View style={ui.flex}>
                    <Txt variant="bodySemi" numberOfLines={1}>
                      {device.name}
                    </Txt>
                    <Txt variant="micro" color={color.textSubtle} numberOfLines={1}>
                      {describeDevice({ moving, speed, inside, lastSeen: live?.recvTs ?? device.lastSeen })}
                    </Txt>
                  </View>

                  {device.battery ? (
                    <Mono size={size.monoSm} color={color.textMuted}>
                      {device.battery}%
                    </Mono>
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

/** describeDevice writes the "Moving · 34 km/h" / "Idle · Home" line from the mock. */
function describeDevice({
  moving,
  speed,
  inside,
  lastSeen,
}: {
  moving: boolean;
  speed: number;
  inside?: string;
  lastSeen?: string;
}): string {
  if (moving) return `Moving · ${Math.round(speed * 3.6)} km/h`;
  if (inside) return `Idle · ${inside}`;
  if (lastSeen) return `Idle · seen ${formatRelative(lastSeen)}`;
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
}: {
  enabled: boolean;
  onToggle: () => void;
  deviceName?: string;
}) {
  return (
    <Card style={styles.trackingCard}>
      <View style={styles.trackingHead}>
        <Dot size={8} color={enabled ? palette.accent : color.timelineNode} pulse={enabled} />
        <Txt variant="bodySemi">{enabled ? 'Publishing this device' : 'This device is not publishing'}</Txt>
      </View>
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
  trackingHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  trackingButton: { marginTop: 6 },
});
