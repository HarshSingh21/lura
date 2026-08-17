import type { Point, Position } from '@/api/types';

import type { Peer, PeerDevice } from './types';

/**
 * Pure helpers over a peer list.
 *
 * They are deliberately free of React and of any formatting: the screen, the live
 * rail and the map all need the same three answers — who can see me, whom can I
 * see, and where is a peer right now — and each renders them differently. Keeping
 * the answers here means the map and the rail cannot disagree about who is live.
 */

/** peerDevices normalises the server's null slice into an array. */
export function peerDevices(peer: Peer): PeerDevice[] {
  return peer.devices ?? [];
}

/** PeerFix is one peer device's current position, live frame or last known. */
export type PeerFix = {
  deviceId: string;
  deviceName: string;
  point: Point;
  speedMps: number;
  lastSeen?: string;
  moving: boolean;
};

/**
 * peerFixes merges the snapshot with the live socket.
 *
 * A peer's fixes arrive as ordinary `position` frames keyed by device id — the
 * same store the user's own devices use — so the only thing that makes a frame a
 * peer's is that its device id appears in that peer's device list. Reading the
 * ids from the snapshot and the coordinates from the store is what makes a peer's
 * marker move between two overview refetches.
 */
export function peerFixes(peer: Peer, positions: Record<string, Position>): PeerFix[] {
  return peerDevices(peer)
    .map((device): PeerFix | null => {
      const live = positions[device.id];
      const point = live?.point ?? device.point;
      if (!point) return null;
      const speedMps = live?.speedMps ?? device.speedMps ?? 0;
      return {
        deviceId: device.id,
        deviceName: device.name,
        point,
        speedMps,
        lastSeen: live?.recvTs ?? device.lastSeen,
        moving: speedMps > 1,
      };
    })
    .filter((fix) => fix !== null);
}

/** latestFix is the freshest of a peer's devices — what a single row can show. */
export function latestFix(peer: Peer, positions: Record<string, Position>): PeerFix | undefined {
  return peerFixes(peer, positions).sort((a, b) => stamp(b.lastSeen) - stamp(a.lastSeen))[0];
}

function stamp(iso?: string): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** Partition splits the list into the three things a person can be to me. */
export type Partition = {
  /** They invited me; nothing flows either way until I accept. */
  incoming: Peer[];
  /** I invited them; nothing flows either way until they accept. */
  outgoing: Peer[];
  accepted: Peer[];
};

export function partitionPeople(people: Peer[]): Partition {
  return {
    incoming: people.filter((p) => p.status === 'pending_in'),
    outgoing: people.filter((p) => p.status === 'pending_out'),
    accepted: people.filter((p) => p.status === 'accepted'),
  };
}

/** watchers is the "who can see me" indicator's data — my switch, resolved. */
export function watchers(people: Peer[]): Peer[] {
  return people.filter((p) => p.watchingMe);
}

/** watched is whom I can see right now — their switch, resolved. */
export function watched(people: Peer[]): Peer[] {
  return people.filter((p) => p.sharingWithMe);
}

/**
 * firstName keeps a two-lane row legible at 360 dp ("You → Nistha").
 *
 * The server falls back to the email address when a peer has no display name, so
 * the local part is the fallback here rather than a whole address wrapping across
 * a lane title.
 */
export function firstName(peer: Peer): string {
  const name = peer.peerName.trim() || peer.peerEmail.trim();
  const local = name.includes('@') ? name.split('@')[0] : name;
  return local?.split(/\s+/)[0] || 'them';
}

/** joinNames writes "Nistha, Arjun and 2 more" for the compact indicators. */
export function joinNames(people: Peer[], max = 3): string {
  const names = people.map((p) => p.peerName || p.peerEmail);
  if (names.length <= max) {
    if (names.length <= 1) return names[0] ?? '';
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  }
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}
