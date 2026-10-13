import type { Position } from '@/api/types';

/**
 * The share viewer's words and rules, kept pure (no React) so they are tested
 * directly: how the share ends, what the page says once it has, and which live
 * fixes may move the dot.
 */

/** `ended` is false for a link that never existed: nothing was ever shared through it. */
export type ShareNotice = { title: string; body: string; ended: boolean };

/**
 * shareEnded is what the recipient reads once a link stops working, from the
 * server's reason (the socket's revoke frame) or the HTTP status of the
 * snapshot. The raw reasons are terse internal strings ("arrived at Office",
 * "expired", "revoked by owner"); a stranger opening a link deserves a sentence.
 */
export function shareEnded({
  reason,
  status,
  sharerName,
}: {
  reason?: string | null;
  status?: number;
  sharerName?: string;
}): ShareNotice {
  const who = firstName(sharerName);
  if (!reason && status === 404) {
    return {
      title: 'This link does not work',
      body: 'There is no share at this address. Check that the whole link was copied, or ask for a new one.',
      ended: false,
    };
  }
  const r = (reason ?? '').trim();
  const arrived = /^arrived at (.+)$/i.exec(r);
  if (arrived) {
    return {
      title: 'This share has ended',
      body: `${who ?? 'They'} arrived at ${arrived[1]}, so the link switched itself off.`,
      ended: true,
    };
  }
  if (/^expired$/i.test(r)) {
    return { title: 'This share has ended', body: 'Its time ran out. Ask for a new link if you still need it.', ended: true };
  }
  if (/^revoked by owner$/i.test(r)) {
    return {
      title: 'This share has ended',
      body: `${who ?? 'The sharer'} stopped sharing. Ask for a new link if you still need it.`,
      ended: true,
    };
  }
  if (r) return { title: 'This share has ended', body: `${capitalise(r)}.`, ended: true };
  return {
    title: 'This share has ended',
    body: 'The link was revoked or has expired. Ask for a new one if you still need it.',
    ended: true,
  };
}

/**
 * describeEnding says how the share ends, counting down where it can.
 *
 * A wall-clock time ("until 3:19") is useless to someone who does not know what
 * time it is on the sharer's clock, so the remaining time leads and the clock time
 * follows it.
 */
export function describeEnding(
  mode: string,
  expiresAt: string | undefined,
  arrivePlace: string | undefined,
  now: number,
): string {
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

export function describeDuration(ms: number): string {
  // Rounded up: "ends in 1 min" for the last 59 seconds would promise a minute
  // that is not there, and "30 min" must not read 29 a second after creation.
  const minutes = Math.ceil(ms / 60_000);
  if (ms < 60_000) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/**
 * acceptFix says whether a live position may replace the one on screen. A fix
 * the server marks late (queued offline, older than one already shown) is
 * history: it would make the dot jump backwards. So is anything older than the
 * fix already shown.
 */
export function acceptFix(current: Position | undefined, next: Position): boolean {
  if (next.late) return false;
  if (!current) return true;
  return fixTime(next) >= fixTime(current);
}

/** fixTime is when the device was at the point: fixTs where the server says, else arrival. */
export function fixTime(p: Pick<Position, 'fixTs' | 'recvTs'>): number {
  const ms = Date.parse(p.fixTs ?? p.recvTs);
  return Number.isNaN(ms) ? 0 : ms;
}

function firstName(name?: string): string | undefined {
  const first = name?.trim().split(/\s+/)[0];
  return first || undefined;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
