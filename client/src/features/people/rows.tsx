import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Position } from '@/api/types';
import { Card, Dot, Toggle, styles as ui } from '@/components/ui/primitives';
import { Mono, Txt } from '@/theme/text';
import { color, palette, radius, size, space } from '@/theme/tokens';

import { formatRelative } from '@/features/live/rail';

import { describePeopleError, useAcceptPerson, useRemovePerson, useSetPeerSharing } from './api';
import { firstName, latestFix } from './peer';
import type { Peer } from './types';

/**
 * The rows of the People screen.
 *
 * The whole design problem here is that a connection is *two* relationships, and
 * a single row with a single switch would quietly imply otherwise. So an accepted
 * peer is drawn as two labelled lanes — "You → Nistha" and "Nistha → You" — each
 * with its own state, its own colour and, where I am allowed one, its own
 * control. Neither lane can be read as the other's summary.
 */

// ------------------------------------------------------------------ actions

type ActionTone = 'primary' | 'secondary' | 'ghost' | 'danger';

/**
 * ActionButton is the primitives' Button with an explicit accessible name.
 *
 * A screen full of rows has a dozen buttons labelled "Remove", so the visible
 * label cannot also be the accessible one: the label says "Remove", the
 * accessible name says "Remove Nistha Dev".
 */
export function ActionButton({
  label,
  accessibilityLabel,
  onPress,
  tone = 'secondary',
  busy,
  disabled,
  style,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
  tone?: ActionTone;
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = actionTone(tone);
  const off = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      onPress={off ? undefined : onPress}
      style={({ pressed }) => [
        ui.button,
        ui.buttonSmall,
        { backgroundColor: t.bg, borderColor: t.border },
        pressed && !off ? ui.pressed : null,
        off ? ui.disabled : null,
        style,
      ]}
    >
      <Txt variant="bodySemi" color={t.fg} style={styles.actionLabel} numberOfLines={1}>
        {busy ? 'Working…' : label}
      </Txt>
    </Pressable>
  );
}

function actionTone(tone: ActionTone) {
  switch (tone) {
    case 'primary':
      return { bg: palette.accent, fg: color.textOnAccent, border: palette.accent };
    case 'ghost':
      return { bg: color.surfaceMuted, fg: color.textMuted, border: 'transparent' };
    case 'danger':
      return { bg: color.surface, fg: palette.dangerInk, border: palette.danger };
    case 'secondary':
      return { bg: color.surface, fg: color.textStrong, border: color.border };
  }
}

// ------------------------------------------------------------------- lanes

export type LaneTone = 'sharing' | 'receiving' | 'off';

/**
 * DirectionLane is one direction of one connection.
 *
 * Colour carries the meaning the rest of the app already assigns it: amber is
 * "you are being seen" (the same amber as the sharing banner), green is "a live
 * position is coming in", grey is "nothing is flowing".
 */
export function DirectionLane({
  title,
  tone,
  state,
  detail,
  mono,
  control,
}: {
  title: string;
  tone: LaneTone;
  state: string;
  detail?: string;
  mono?: string;
  control?: ReactNode;
}) {
  const t = laneTone(tone);
  return (
    <View style={[styles.lane, { backgroundColor: t.bg, borderLeftColor: t.rail }]}>
      <View style={ui.flex}>
        <View style={styles.laneHead}>
          <Dot size={7} color={t.dot} blink={tone === 'sharing'} />
          <Mono heading color={t.title} style={styles.laneTitle}>
            {title}
          </Mono>
        </View>
        <Txt variant="bodySemi" color={tone === 'off' ? color.textMuted : color.textStrong}>
          {state}
        </Txt>
        {detail ? (
          <Txt variant="micro" color={color.textSubtle} style={styles.laneDetail}>
            {detail}
          </Txt>
        ) : null}
        {mono ? (
          <Mono size={size.monoSm} color={color.textFaint} style={styles.laneMono}>
            {mono}
          </Mono>
        ) : null}
      </View>
      {control ? <View style={styles.laneControl}>{control}</View> : null}
    </View>
  );
}

function laneTone(tone: LaneTone) {
  switch (tone) {
    case 'sharing':
      return {
        bg: color.amberSofter,
        rail: palette.amber,
        dot: palette.amberDot,
        title: palette.amberInk,
      };
    case 'receiving':
      return {
        bg: color.accentSofter,
        rail: palette.accent,
        dot: palette.accent,
        title: palette.accentInk,
      };
    case 'off':
      return {
        bg: color.surfaceMuted,
        rail: color.neutralDot,
        dot: color.neutralDot,
        title: color.textFaint,
      };
  }
}

// -------------------------------------------------------------- peer rows

/** PeerRow is one accepted connection, drawn as its two independent directions. */
export function PeerRow({ peer, positions }: { peer: Peer; positions: Record<string, Position> }) {
  const setSharing = useSetPeerSharing();
  const remove = useRemovePerson();
  const [confirming, setConfirming] = useState(false);

  const name = peer.peerName || peer.peerEmail;
  const short = firstName(peer);
  // While the PATCH is in flight the switch shows where it is going, not where it
  // was: a privacy control that appears not to have moved invites a second tap.
  const sharing = setSharing.isPending ? (setSharing.variables?.sharing ?? peer.sharing) : peer.sharing;
  const fix = latestFix(peer, positions);

  const inbound = peer.sharingWithMe
    ? {
        tone: 'receiving' as const,
        state: fix
          ? fix.moving
            ? `Sharing with you · moving ${Math.round(fix.speedMps * 3.6)} km/h`
            : 'Sharing with you · not moving'
          : 'Sharing with you · no position yet',
        detail: fix
          ? fix.lastSeen
            ? `${fix.deviceName} · seen ${formatRelative(fix.lastSeen)}`
            : fix.deviceName
          : 'Their devices have not reported a position to this server yet.',
        mono: fix ? `${fix.point.lat.toFixed(5)}, ${fix.point.lon.toFixed(5)}` : undefined,
      }
    : {
        tone: 'off' as const,
        state: `${short} is not sharing with you`,
        detail: `They have paused their side. Only ${short} can turn it back on — you will see them again the moment they do.`,
        mono: undefined,
      };

  return (
    <Card style={styles.peerCard}>
      <View style={styles.peerHead}>
        <View style={[styles.avatar, peer.sharingWithMe ? styles.avatarLive : null]}>
          <Txt variant="bodySemi" color={peer.sharingWithMe ? palette.accentInk : color.textMuted}>
            {initials(name)}
          </Txt>
        </View>
        <View style={ui.flex}>
          <Txt variant="cardTitle" numberOfLines={1}>
            {name}
          </Txt>
          <Mono size={size.monoSm} color={color.textFaint} numberOfLines={1}>
            {peer.peerEmail}
          </Mono>
        </View>
      </View>

      <View style={styles.lanes}>
        <DirectionLane
          title={`YOU → ${short.toUpperCase()}`}
          tone={sharing ? 'sharing' : 'off'}
          state={sharing ? `${short} can see you` : `${short} cannot see you`}
          detail={
            sharing
              ? 'Your live position is sent to them until you switch this off.'
              : 'Paused by you. Nothing of yours reaches them, and the connection stays.'
          }
          control={
            <Toggle
              value={sharing}
              onChange={(next) => setSharing.mutate({ peerId: peer.peerId, sharing: next })}
              accessibilityLabel={`Share my live location with ${name}`}
            />
          }
        />
        <DirectionLane
          title={`${short.toUpperCase()} → YOU`}
          tone={inbound.tone}
          state={inbound.state}
          detail={inbound.detail}
          mono={inbound.mono}
        />
      </View>

      {setSharing.error ? (
        <Txt variant="micro" color={palette.dangerInk}>
          {describePeopleError(setSharing.error, 'Could not change your sharing switch.')}
        </Txt>
      ) : null}

      {confirming ? (
        <View style={styles.confirm}>
          <Txt variant="micro" color={palette.dangerInk} style={styles.confirmText}>
            Remove {name}? This removes the connection for both of you: neither of you will see the other,
            and one of you would have to invite the other again.
          </Txt>
          <View style={styles.rowActions}>
            <ActionButton
              label="Cancel"
              tone="ghost"
              accessibilityLabel={`Keep the connection with ${name}`}
              onPress={() => setConfirming(false)}
            />
            <ActionButton
              label="Remove for both"
              tone="danger"
              busy={remove.isPending}
              accessibilityLabel={`Remove ${name} for both of you`}
              onPress={() => remove.mutate(peer.peerId)}
            />
          </View>
          {remove.error ? (
            <Txt variant="micro" color={palette.dangerInk}>
              {describePeopleError(remove.error, 'Could not remove the connection.')}
            </Txt>
          ) : null}
        </View>
      ) : (
        <View style={styles.rowActions}>
          <ActionButton
            label="Remove"
            tone="danger"
            accessibilityLabel={`Remove ${name}`}
            onPress={() => setConfirming(true)}
          />
        </View>
      )}
    </Card>
  );
}

/** IncomingRow is an invitation waiting on me — the only row that is loud. */
export function IncomingRow({ peer }: { peer: Peer }) {
  const accept = useAcceptPerson();
  const remove = useRemovePerson();
  const name = peer.peerName || peer.peerEmail;

  return (
    <View style={styles.incomingCard}>
      <View style={styles.peerHead}>
        <Dot size={9} color={palette.accent} pulse />
        <View style={ui.flex}>
          <Txt variant="bodySemi">{name} wants to connect</Txt>
          <Mono size={size.monoSm} color={color.textMuted} numberOfLines={1}>
            {peer.peerEmail}
          </Mono>
        </View>
      </View>

      <Txt variant="micro" color={color.textMuted} style={styles.incomingBody}>
        Accepting opens both directions: they can see you and you can see them. Each side keeps its own
        switch afterwards, so either of you can pause without removing anything.
      </Txt>

      <View style={styles.rowActions}>
        <ActionButton
          label="Accept"
          tone="primary"
          busy={accept.isPending}
          accessibilityLabel={`Accept the invitation from ${name}`}
          onPress={() => accept.mutate(peer.peerId)}
        />
        <ActionButton
          label="Decline"
          tone="ghost"
          busy={remove.isPending}
          accessibilityLabel={`Decline the invitation from ${name}`}
          onPress={() => remove.mutate(peer.peerId)}
        />
      </View>

      {accept.error || remove.error ? (
        <Txt variant="micro" color={palette.dangerInk}>
          {describePeopleError(accept.error ?? remove.error, 'Could not answer the invitation.')}
        </Txt>
      ) : null}
    </View>
  );
}

/** OutgoingRow is an invitation I sent: nothing flows either way until they accept. */
export function OutgoingRow({ peer }: { peer: Peer }) {
  const remove = useRemovePerson();
  const name = peer.peerName || peer.peerEmail;

  return (
    <Card style={styles.pendingCard}>
      <Dot size={8} color={color.neutralDot} />
      <View style={ui.flex}>
        <Txt variant="bodySemi" numberOfLines={1}>
          {name}
        </Txt>
        <Txt variant="micro" color={color.textSubtle} numberOfLines={2}>
          Waiting for them to accept · invited {formatRelative(peer.createdAt)}. Nothing is shared in either
          direction yet.
        </Txt>
        {remove.error ? (
          <Txt variant="micro" color={palette.dangerInk}>
            {describePeopleError(remove.error, 'Could not withdraw the invitation.')}
          </Txt>
        ) : null}
      </View>
      <ActionButton
        label="Withdraw"
        tone="ghost"
        busy={remove.isPending}
        accessibilityLabel={`Withdraw the invitation to ${name}`}
        onPress={() => remove.mutate(peer.peerId)}
      />
    </Card>
  );
}

/** initials keeps the avatar readable for one-word and two-word names alike. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

const styles = StyleSheet.create({
  actionLabel: { fontSize: size.small, letterSpacing: -0.1 },

  lane: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    borderLeftWidth: 3,
    borderRadius: radius.md,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  laneHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  laneTitle: { letterSpacing: 0.85 },
  laneDetail: { marginTop: 2, lineHeight: 15 },
  laneMono: { marginTop: 3 },
  laneControl: { alignItems: 'flex-end' },

  peerCard: { gap: space.lg, padding: space.xl },
  peerHead: { flexDirection: 'row', alignItems: 'center', gap: space.lg },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.lg,
    backgroundColor: color.neutralChip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarLive: { backgroundColor: color.accentSoft },
  lanes: { gap: space.md },

  rowActions: { flexDirection: 'row', gap: space.md, flexWrap: 'wrap' },
  confirm: {
    gap: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: palette.danger,
    padding: space.lg,
  },
  confirmText: { lineHeight: 16 },

  incomingCard: {
    gap: space.lg,
    backgroundColor: color.accentSoft,
    borderWidth: 1,
    borderColor: 'rgba(32,160,123,0.4)',
    borderRadius: radius.cardLg,
    padding: space.xl,
  },
  incomingBody: { lineHeight: 16 },

  pendingCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: 13,
    paddingHorizontal: 15,
  },
});
