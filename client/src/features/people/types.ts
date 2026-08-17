import type { Overview, Point } from '@/api/types';

/**
 * Wire types for People — mutual live sharing between accounts (HLD §2.1, §11).
 *
 * They live beside the feature rather than in src/api/types.ts because the shape
 * is only meaningful next to the rule it encodes: the server keeps *two* rows for
 * a connection, one per direction, each owned by its user. Nothing here is
 * symmetric, and the types are named so that a reader cannot mistake one
 * direction's field for the other's.
 */

/**
 * PeerStatus is the state of *my* row.
 *
 *   pending_out — I invited them and they have not accepted.
 *   pending_in  — they invited me; nothing flows either way until I accept.
 *   accepted    — the relationship exists; each side's switch decides the rest.
 */
export type PeerStatus = 'pending_out' | 'pending_in' | 'accepted';

/**
 * PeerDevice is one of a peer's devices reduced to what a viewer may see: a name
 * and a position. No battery, no history, no notes. It is only ever populated
 * while the peer is actually sharing with me.
 */
export type PeerDevice = {
  id: string;
  name: string;
  point?: Point;
  speedMps?: number;
  lastSeen?: string;
};

/** PeerConnection is the row itself, as returned by the mutating endpoints. */
export type PeerConnection = {
  id: string;
  userId: string;
  peerId: string;
  peerName: string;
  peerEmail: string;
  status: PeerStatus;
  /**
   * My own switch: whether this peer may see me. Theirs is a different row and
   * this client can never write it.
   */
  sharing: boolean;
  createdAt: string;
  updatedAt: string;
};

/** Peer is a connection rendered for the UI: my row, plus both resolved directions. */
export type Peer = PeerConnection & {
  /** My switch resolved — `status === 'accepted' && sharing`. They can see me. */
  watchingMe: boolean;
  /** Their switch resolved, read from their row. I can see them. */
  sharingWithMe: boolean;
  /** Go marshals a nil slice as null, so this is not merely optional. */
  devices?: PeerDevice[] | null;
};

/**
 * GET /api/v1/overview already carries `people`; the shared Overview type
 * predates the endpoint and is owned elsewhere, so the field is declared here
 * instead of being bolted onto it.
 */
export type OverviewWithPeople = Overview & { people?: Peer[] | null };

/** peopleOf reads the people list off an overview snapshot. */
export function peopleOf(overview: Overview | undefined): Peer[] {
  return (overview as OverviewWithPeople | undefined)?.people ?? [];
}
