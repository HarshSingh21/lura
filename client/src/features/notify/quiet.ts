/**
 * Quiet hours, as the viewer set them in Settings.
 *
 * The server holds back *push* during quiet hours and still delivers the in-app
 * reminder, so it is waiting on screen in the morning (internal/notify). The
 * in-app side has to keep the other half of that promise: the toast appears, but
 * it does not chime, vibrate or raise a system notification — a laptop left open
 * at night should not ring because someone walked past a shop.
 *
 * This mirrors inQuietHours in internal/notify/worker.go exactly: the window is
 * read in the viewer's own timezone, "HH:MM" to "HH:MM", wrapping midnight when
 * from > to, empty or equal ends meaning "off".
 *
 * Dependency-free so `node --test` runs it directly (quiet.test.mts).
 */

export type QuietHours = { from: string; to: string; tz?: string };

function parseHM(s: string): number | null {
  const m = /^\s*(\d{1,2}):(\d{1,2})\s*$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutesInZone is the wall-clock minute of the day at `now` in `tz` (UTC when unknown). */
export function minutesInZone(now: number, tz?: string): number {
  const read = (zone: string) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(
      new Date(now),
    );
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    return h * 60 + m;
  };
  try {
    return read(tz || 'UTC');
  } catch {
    return read('UTC');
  }
}

export function inQuietHours(q: QuietHours | null | undefined, now = Date.now()): boolean {
  if (!q || !q.from || !q.to) return false;
  const from = parseHM(q.from);
  const to = parseHM(q.to);
  if (from === null || to === null || from === to) return false;
  const mins = minutesInZone(now, q.tz);
  return from < to ? mins >= from && mins < to : mins >= from || mins < to;
}
