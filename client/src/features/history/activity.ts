import type { ActivityItem, Point, ReminderRecord, Trigger } from '../../api/types';

/**
 * The History screen's timeline, as plain data (release spec §7).
 *
 * The server sends a merged, newest-first feed of everything that happened to
 * the viewer — trips and stops, fence crossings, reminders and their
 * acknowledgements, connection and share changes. This file decides which day
 * a moment belongs to (in the *user's* timezone, not the device's: a day in
 * Bengaluru is a day in Bengaluru wherever the laptop thinks it is), how each
 * entry reads ("Nishtha passed Grocery", "Reminder: buy milk — acknowledged
 * 08:52"), how the day is grouped, and what tapping an entry should show on
 * the map. No React, no platform API, type-only imports: `node --test` runs it
 * (activity.test.mts).
 */

// ---------------------------------------------------------------- time zones

type Parts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** validZone returns tz if this runtime knows it, else the device's zone (or UTC). */
export function validZone(tz: string | undefined): string {
  if (tz) {
    try {
      formatter(tz);
      return tz;
    } catch {
      // Unknown to this engine: fall through.
    }
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** zonedParts is the wall-clock reading of an instant in a zone. */
export function zonedParts(ms: number, tz: string): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour) % 24,
    minute: Number(out.minute),
    weekday: Math.max(0, WEEKDAYS.indexOf(out.weekday ?? '')),
  };
}

/** offsetMs is how far the zone's wall clock is ahead of UTC at an instant. */
function offsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const seconds = new Date(ms).getUTCSeconds();
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, seconds, new Date(ms).getUTCMilliseconds());
  return wall - ms;
}

/** zonedMidnight is the instant a calendar date starts in a zone (DST-safe). */
function zonedMidnight(year: number, month: number, day: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day);
  let start = guess - offsetMs(guess, tz);
  // Once more at the candidate, in case an offset change sits between the two.
  start = guess - offsetMs(start, tz);
  return start;
}

export type DayRange = {
  /** 0 = today, 1 = yesterday, … */
  offset: number;
  /** YYYY-MM-DD in the zone. */
  key: string;
  /** Inclusive start and exclusive end, as RFC 3339 UTC. */
  from: string;
  to: string;
  startMs: number;
  endMs: number;
};

/** dayRange is the window of the day `offset` days before today, in `tz`. */
export function dayRange(offset: number, tz: string, now = Date.now()): DayRange {
  const today = zonedParts(now, tz);
  // Calendar arithmetic on a UTC date, which has no DST to trip over.
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day - offset));
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const startMs = zonedMidnight(y, m, d, tz);
  const endMs = zonedMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), tz);
  return {
    offset,
    key: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(),
    startMs,
    endMs,
  };
}

/** dayLabel is the picker's caption: "Today", "Yesterday", "Sat 10 Oct". */
export function dayLabel(offset: number, tz: string, now = Date.now()): string {
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Yesterday';
  const range = dayRange(offset, tz, now);
  // Noon of that day, safely inside it whatever the offset.
  const p = zonedParts(range.startMs + 12 * 3_600_000, tz);
  const label = `${WEEKDAYS[p.weekday]} ${p.day} ${MONTHS[p.month - 1]}`;
  return p.year === zonedParts(now, tz).year ? label : `${label} ${p.year}`;
}

/** formatClock is a 24-hour "08:52" in the zone. */
export function formatClock(iso: string | number | undefined, tz: string): string {
  if (iso === undefined || iso === '') return '';
  const ms = typeof iso === 'number' ? iso : new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const p = zonedParts(ms, tz);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function formatDuration(startTs: string | undefined, endTs: string | undefined): string {
  if (!startTs || !endTs) return '';
  const ms = new Date(endTs).getTime() - new Date(startTs).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatKm(metres: number | undefined): string {
  const m = metres ?? 0;
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// ---------------------------------------------------------------- describing

export type ActivityIcon =
  'history' | 'places' | 'arrive' | 'leave' | 'passby' | 'dwell' | 'bell' | 'check' | 'people' | 'sharing';

/** What tapping an entry shows on the map. */
export type ActivityFocus = { path?: Point[]; point?: Point; placeId?: string; placeName?: string };

export type ActivityRow = {
  id: string;
  type: ActivityItem['type'];
  ts: string;
  /** Epoch ms, for ordering. */
  at: number;
  /** "08:52" in the user's zone. */
  time: string;
  icon: ActivityIcon;
  title: string;
  detail?: string;
  /** A person this is about (their colour tints the icon). */
  personId?: string;
  /** For a reminder: where it stands. */
  status?: 'pending' | 'acknowledged';
  focus?: ActivityFocus;
};

const VERB: Record<Trigger, { self: string; peer: string }> = {
  arrive: { self: 'Arrived at', peer: 'arrived at' },
  leave: { self: 'Left', peer: 'left' },
  passby: { self: 'Passed', peer: 'passed' },
  dwell: { self: 'Stayed at', peer: 'is staying at' },
};

function stamp(iso: string | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function quoted(label: string | undefined): string {
  return label?.trim() ? ` “${label.trim()}”` : '';
}

/** reminderStatus is "acknowledged 08:52" / "pending". */
function reminderStatus(r: Pick<ReminderRecord, 'status' | 'ackedAt'>, tz: string): string {
  if (r.status === 'acknowledged') {
    const at = formatClock(r.ackedAt, tz);
    return at ? `acknowledged ${at}` : 'acknowledged';
  }
  return 'pending';
}

/**
 * noteLabel is what a reminder is *about*. The server titles a note's reminder
 * with the crossing ("Arrived at Whole Foods") and carries the note's own text
 * in the body ("buy milk"); the timeline already says where, so the note wins.
 */
function noteLabel(r: { kind?: string; title?: string; body?: string }): string {
  const body = r.body?.trim();
  if (r.kind !== 'watch' && body) return body;
  return r.title?.trim() || 'note';
}

function join(...parts: (string | undefined | false)[]): string | undefined {
  const s = parts.filter((p): p is string => !!p && p.trim() !== '').join(' · ');
  return s || undefined;
}

export type DescribeContext = { tz: string; viewerId?: string; multipleDevices?: boolean };

/** describe is one feed entry as a timeline row. */
export function describe(item: ActivityItem, ctx: DescribeContext): ActivityRow {
  const base = { id: item.id, type: item.type, ts: item.ts, at: stamp(item.ts), time: formatClock(item.ts, ctx.tz) };
  switch (item.type) {
    case 'trip':
      return {
        ...base,
        icon: 'history',
        title: `${item.fromPlace || 'Somewhere'} → ${item.toPlace || 'somewhere'}`,
        detail: join(
          item.mode,
          formatDuration(item.startTs, item.endTs),
          formatKm(item.distanceM),
          ctx.multipleDevices && item.deviceName,
        ),
        focus: item.path?.length ? { path: item.path } : undefined,
      };
    case 'stop': {
      const range = [formatClock(item.startTs, ctx.tz), formatClock(item.endTs, ctx.tz)].filter(Boolean).join('–');
      return {
        ...base,
        icon: 'places',
        title: `Stopped at ${item.atPlace || 'an unnamed spot'}`,
        detail: join(formatDuration(item.startTs, item.endTs), range, ctx.multipleDevices && item.deviceName),
        focus: item.point ? { point: item.point, placeName: item.atPlace } : undefined,
      };
    }
    case 'geo': {
      const peer = !!item.subjectUserId && item.subjectUserId !== ctx.viewerId;
      const verb = VERB[item.trigger] ?? { self: 'Crossed', peer: 'crossed' };
      const place = item.placeName || 'a place';
      return {
        ...base,
        icon: item.trigger in VERB ? item.trigger : 'arrive',
        title: peer ? `${item.subjectName || 'Someone'} ${verb.peer} ${place}` : `${verb.self} ${place}`,
        personId: peer ? item.subjectUserId : undefined,
        focus: { placeId: item.placeId, placeName: item.placeName },
      };
    }
    case 'reminder': {
      const r = item.reminder;
      const watch = r.kind === 'watch';
      const peer = !!r.subjectUserId && r.subjectUserId !== ctx.viewerId && r.subjectUserId !== r.userId;
      return {
        ...base,
        icon: 'bell',
        title: `${watch ? r.title || 'Watched crossing' : `Reminder: ${noteLabel(r)}`} — ${reminderStatus(r, ctx.tz)}`,
        detail: join(r.placeName, r.fromName && `from ${r.fromName}`),
        personId: peer ? r.subjectUserId : undefined,
        status: r.status,
        focus: r.placeId ? { placeId: r.placeId, placeName: r.placeName } : undefined,
      };
    }
    case 'ack':
      return {
        ...base,
        icon: 'check',
        title: item.byMe
          ? `Acknowledged ${noteLabel(item)}`
          : `${item.ackedByName || 'Someone'} acknowledged ${noteLabel(item)}`,
        detail: join(item.placeName),
        personId: item.byMe ? undefined : item.ackedBy,
        focus: item.placeName ? { placeName: item.placeName } : undefined,
      };
    case 'connection':
      return { ...base, icon: 'people', title: connectionTitle(item), personId: item.peerId };
    case 'share':
      return {
        ...base,
        icon: 'sharing',
        title: item.action === 'revoked' ? `Stopped sharing${quoted(item.label)}` : `Shared live${quoted(item.label)}`,
        detail: join(item.reason),
      };
  }
}

function connectionTitle(item: Extract<ActivityItem, { type: 'connection' }>): string {
  const who = item.peerName || 'someone';
  const Who = item.peerName || 'Someone';
  switch (item.action) {
    case 'invited':
      return item.byMe ? `Invited ${who} to connect` : `${Who} invited you to connect`;
    case 'accepted':
      return item.byMe ? `Connected with ${who}` : `${Who} accepted your invitation`;
    case 'paused':
      return item.byMe ? `Paused sharing with ${who}` : `${Who} paused sharing`;
    case 'resumed':
      return item.byMe ? `Resumed sharing with ${who}` : `${Who} resumed sharing`;
    case 'removed':
      return item.byMe ? `Removed ${who}` : `${Who} removed the connection`;
    default:
      return `${Who}: ${String(item.action)}`;
  }
}

// ---------------------------------------------------------------- grouping

export type ActivitySection = {
  key: 'night' | 'morning' | 'afternoon' | 'evening';
  title: string;
  rows: ActivityRow[];
};

const SECTIONS: { key: ActivitySection['key']; title: string; until: number }[] = [
  { key: 'night', title: 'EARLY HOURS', until: 5 },
  { key: 'morning', title: 'MORNING', until: 12 },
  { key: 'afternoon', title: 'AFTERNOON', until: 17 },
  { key: 'evening', title: 'EVENING', until: 24 },
];

/**
 * buildTimeline turns a day's feed into the rows the screen draws: one row per
 * entry, in the order the day happened, under part-of-day headings.
 *
 * A reminder fired by a crossing in the same feed folds into that crossing's
 * row ("Passed Grocery — reminder buy milk · acknowledged 08:52") instead of
 * standing beside it a second later. The acknowledgement keeps its own row: it
 * happened at its own time.
 */
export function buildTimeline(items: ActivityItem[], ctx: DescribeContext): ActivitySection[] {
  const seen = new Set<string>();
  const unique = items.filter((i) => (seen.has(`${i.type}:${i.id}`) ? false : (seen.add(`${i.type}:${i.id}`), true)));

  const geos = unique.filter((i): i is Extract<ActivityItem, { type: 'geo' }> => i.type === 'geo');
  const folded = new Map<string, ReminderRecord[]>();
  const rest: ActivityItem[] = [];
  for (const i of unique) {
    const geo = i.type === 'reminder' ? crossingOf(i, geos) : undefined;
    if (i.type === 'reminder' && geo) {
      const list = folded.get(geo.id) ?? [];
      list.push(i.reminder);
      folded.set(geo.id, list);
      continue;
    }
    rest.push(i);
  }

  const rows = rest.map((i) => {
    const row = describe(i, ctx);
    if (i.type !== 'geo') return row;
    const reminders = folded.get(i.id);
    if (!reminders?.length) return row;
    const pending = reminders.some((r) => r.status === 'pending');
    return {
      ...row,
      title: `${row.title} — reminder ${reminders.map((r) => noteLabel(r)).join(', ')}`,
      // A pending one is said by the row's PENDING chip; "pending" beside it
      // again is noise. Acknowledged ones say when.
      detail: join(row.detail, ...reminders.filter((r) => r.status !== 'pending').map((r) => reminderStatus(r, ctx.tz))),
      status: pending ? ('pending' as const) : ('acknowledged' as const),
    };
  });

  rows.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));

  const sections: ActivitySection[] = SECTIONS.map((s) => ({ key: s.key, title: s.title, rows: [] }));
  for (const row of rows) {
    const hour = row.at ? zonedParts(row.at, ctx.tz).hour : 0;
    const index = SECTIONS.findIndex((s) => hour < s.until);
    sections[index < 0 ? SECTIONS.length - 1 : index]!.rows.push(row);
  }
  return sections.filter((s) => s.rows.length > 0);
}

/** Within this of each other, a reminder and a crossing at the same fence are one moment. */
const SAME_MOMENT_MS = 5_000;

/**
 * crossingOf finds the crossing a reminder came from: by event id (both carry
 * the GeoEvent id), or — for a crossing recorded before the server kept that id,
 * which the feed names by its trigger-event id — by the same fence, trigger and
 * notes at the same moment.
 */
function crossingOf(
  item: Extract<ActivityItem, { type: 'reminder' }>,
  geos: Extract<ActivityItem, { type: 'geo' }>[],
): Extract<ActivityItem, { type: 'geo' }> | undefined {
  const r = item.reminder;
  if (r.kind === 'ack') return undefined;
  const byId = r.eventId ? geos.find((g) => g.eventId === r.eventId) : undefined;
  if (byId) return byId;
  const at = stamp(r.createdAt || item.ts);
  return geos.find(
    (g) =>
      g.placeId === r.placeId &&
      g.trigger === r.trigger &&
      Math.abs(stamp(g.ts) - at) <= SAME_MOMENT_MS &&
      (r.noteIds.length === 0 || r.noteIds.some((n) => g.noteIds.includes(n))),
  );
}

/** inDay keeps only entries inside the window (the server's bounds are inclusive at both ends). */
export function inDay(items: ActivityItem[], range: Pick<DayRange, 'startMs' | 'endMs'>): ActivityItem[] {
  return items.filter((i) => {
    const at = stamp(i.ts);
    return at >= range.startMs && at < range.endMs;
  });
}
