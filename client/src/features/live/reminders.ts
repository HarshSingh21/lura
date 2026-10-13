import type { Note } from '@/api/types';
import type { ReminderCard } from '@/features/notify/reminders';
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

export type UpcomingNote = {
  note: Note;
  /** Why it cannot fire now, if it cannot (reminderHold). */
  hold?: string;
  /** It has gone off and its reminder card is waiting to be acknowledged. */
  waiting: boolean;
};

/** WAITING_LINE is what the rail says under a note whose reminder is up. */
export const WAITING_LINE = 'Went off · waiting for you to acknowledge it';

/**
 * upcomingNotes is the rail's "Upcoming reminders": open notes bound to a place.
 * One whose reminder has gone off and waits on a card is no longer armed: it is
 * listed first and says so, rather than reading as a reminder still to come,
 * and still says if it is on hold. Armed ones follow, then those on hold. At
 * most `limit`.
 */
export function upcomingNotes(
  notes: Note[],
  people: Peer[],
  cards: Pick<ReminderCard, 'noteIds'>[] = [],
  limit = 6,
): UpcomingNote[] {
  const waitingIds = new Set(cards.flatMap((c) => c.noteIds ?? []));
  const rank = (u: UpcomingNote) => (u.waiting ? 0 : u.hold ? 2 : 1);
  return notes
    .filter((note) => !note.done && note.placeId)
    .map((note) => {
      const waiting = waitingIds.has(note.id);
      // Waiting and on hold are both true of a note that went off just before
      // its person was removed: the card is still up, and once acknowledged it
      // will not fire again. The rail says both.
      return { note, hold: reminderHold(note, people), waiting };
    })
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, limit);
}
