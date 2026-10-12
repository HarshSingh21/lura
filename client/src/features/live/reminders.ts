import type { Note } from '@/api/types';
import type { Peer } from '@/features/people/types';

/**
 * reminderHold says why an armed note cannot fire right now, if it cannot.
 *
 * A note that watches a connected person fires only while that person shares
 * live with the note's owner (docs/release-spec.md §2), so pausing or removing
 * the connection puts it on hold. Listing it as armed then would promise a
 * reminder the server will never send. Kept pure (no React) so it is tested
 * directly.
 */
export function reminderHold(note: Pick<Note, 'userId' | 'watchUserId'>, people: Peer[]): string | undefined {
  if (!note.watchUserId || note.watchUserId === note.userId) return undefined;
  const peer = people.find((p) => p.peerId === note.watchUserId && p.status === 'accepted');
  if (!peer) return 'On hold · the person it watches is no longer connected';
  if (!peer.sharingWithMe) return `On hold · ${firstName(peer.peerName)} paused sharing with you`;
  return undefined;
}

/** firstName is how the rail refers to a person in a sentence. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || 'they';
}
