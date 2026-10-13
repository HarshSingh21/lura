/**
 * Which chime a notification rings, and when it rings at all: one sound per
 * trigger, the watch bell on a watched person's crossing, mute (sound only),
 * quiet hours (nothing sounds or pops up), and the repeat for a pending card.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MASTER,
  MIN_GAP_MS,
  MUTE_KEY,
  PEAK,
  TONES,
  VIBRATION,
  WATCH_BELL,
  WATCH_BUZZ,
  chimeGate,
  chimeTones,
  readMuted,
  vibrationPattern,
  writeMuted,
} from './chimes.ts';
import { announcement, chimeFor, reminderTag, type ChimeKind, type NotificationItem } from './model.ts';
import { inQuietHours } from './quiet.ts';
import { repeatAction, silence } from './reminders.ts';

const KINDS: ChimeKind[] = ['arrive', 'leave', 'passby', 'dwell'];
type Item = Pick<NotificationItem, 'kind' | 'trigger' | 'status' | 'reminderId'>;
const item = (over: Partial<Item>): Item => ({ kind: 'geo', trigger: 'arrive', ...over });

test('each trigger rings its own chime; a watched person adds the bell; an ack is the soft knock', () => {
  for (const trigger of KINDS) {
    for (const kind of ['geo', 'note'] as const) assert.deepEqual(chimeFor(item({ kind, trigger })), { kind: trigger, watched: false });
    assert.deepEqual(chimeFor(item({ kind: 'watch', trigger })), { kind: trigger, watched: true });
  }
  assert.deepEqual(chimeFor(item({ kind: 'ack', trigger: 'leave' })), { kind: 'dwell', watched: false });
});

test('the four chimes are tellable apart: different notes, arrive rises and leave falls', () => {
  const signature = (k: ChimeKind) => TONES[k].map((t) => `${t.freq}@${t.at}`).join(',');
  assert.equal(new Set(KINDS.map(signature)).size, 4);
  const [a0, a1] = TONES.arrive;
  const [l0, l1] = TONES.leave;
  assert.ok(a1!.freq > a0!.freq, 'arrive rises');
  assert.ok(l1!.freq < l0!.freq, 'leave falls');
  // On a phone, four different vibration patterns.
  assert.equal(new Set(KINDS.map((k) => VIBRATION[k].join(','))).size, 4);
});

test('"Nishtha arrived" and "Nishtha left" still differ, and both differ from my own crossing', () => {
  const sig = (k: ChimeKind, w: boolean) => chimeTones(k, w).map((t) => t.freq).join(',');
  assert.notEqual(sig('arrive', true), sig('leave', true));
  assert.notEqual(sig('arrive', true), sig('arrive', false));
  // The bell comes after the trigger's own notes, so the chime starts on its trigger's note.
  assert.deepEqual(chimeTones('leave', true).slice(0, TONES.leave.length), TONES.leave);
  assert.deepEqual(chimeTones('leave', true).slice(TONES.leave.length), WATCH_BELL);
  assert.deepEqual(vibrationPattern('arrive', true), [...VIBRATION.arrive, ...WATCH_BUZZ]);
  assert.deepEqual(vibrationPattern('arrive'), VIBRATION.arrive);
});

test('volume safety: every note is short and quiet, and the master gain keeps the sum low', () => {
  for (const k of KINDS) {
    for (const t of chimeTones(k, true)) {
      assert.ok(t.dur > 0 && t.dur <= 0.6, `${k} note ${t.freq} rings ${t.dur}s`);
      assert.ok((t.gain ?? 1) <= 1);
      assert.ok(t.freq >= 200 && t.freq <= 4000);
    }
    // Even if every note of a chime peaked at once, the sum stays well below full scale.
    const sum = chimeTones(k, true).reduce((s, t) => s + PEAK * (t.gain ?? 1), 0) * MASTER;
    assert.ok(sum < 0.5, `${k} could sum to ${sum}`);
  }
});

test('a burst of crossings is one sound: chimes closer than the gap are dropped', () => {
  const may = chimeGate();
  assert.equal(may(1000), true);
  assert.equal(may(1000 + MIN_GAP_MS - 1), false);
  assert.equal(may(1000 + MIN_GAP_MS), true);
  assert.equal(may(5000), true);
});

test('announce: a crossing chimes and raises a system notification for a hidden tab', () => {
  assert.deepEqual(announcement(item({ kind: 'watch', trigger: 'leave' }), { muted: false }), {
    chime: { kind: 'leave', watched: true },
    desktop: { silent: false, requireInteraction: false, tag: undefined },
  });
});

test('announce: mute silences the sound only — the notification still appears, silently', () => {
  assert.deepEqual(announcement(item({ trigger: 'passby' }), { muted: true }), {
    chime: null,
    desktop: { silent: true, requireInteraction: false, tag: undefined },
  });
});

test('announce: quiet hours hold back sound and the system notification, muted or not', () => {
  for (const muted of [false, true]) {
    assert.deepEqual(announcement(item({ kind: 'note', status: 'pending', reminderId: 'rem_1' }), { muted, quiet: true }), {
      chime: null,
      desktop: null,
    });
  }
});

test('announce: a pending reminder stays on the desktop, tagged so its repeat replaces it', () => {
  const a = announcement(item({ kind: 'note', trigger: 'arrive', status: 'pending', reminderId: 'rem_42' }), { muted: false });
  assert.deepEqual(a.desktop, { silent: false, requireInteraction: true, tag: 'reminder:rem_42' });
  assert.equal(reminderTag('rem_42'), 'reminder:rem_42');
  // Once acknowledged it is an ordinary notification again.
  const done = announcement(item({ kind: 'note', status: 'acknowledged', reminderId: 'rem_42' }), { muted: false });
  assert.deepEqual(done.desktop, { silent: false, requireInteraction: false, tag: undefined });
});

test('the repeat of a pending card: quiet beats everything, hidden goes to the desktop, mute is noted', () => {
  assert.equal(repeatAction({ quiet: true, visible: true, muted: false }), 'quiet');
  assert.equal(repeatAction({ quiet: true, visible: false, muted: true }), 'quiet');
  assert.equal(repeatAction({ quiet: false, visible: false, muted: false }), 'desktop');
  assert.equal(repeatAction({ quiet: false, visible: false, muted: true }), 'desktop');
  assert.equal(repeatAction({ quiet: false, visible: true, muted: true }), 'muted');
  assert.equal(repeatAction({ quiet: false, visible: true, muted: false }), 'sound');
  // The card says why it is silent: quiet hours first.
  assert.equal(silence({ muted: true, quiet: true }), 'quiet');
  assert.equal(silence({ muted: true, quiet: false }), 'muted');
  assert.equal(silence({ muted: false, quiet: false }), null);
});

test('quiet hours decide in the viewer\'s timezone: 23:30 in Kolkata is quiet for 22:00–07:00', () => {
  const night = Date.UTC(2026, 9, 12, 18, 0); // 23:30 IST
  const day = Date.UTC(2026, 9, 13, 6, 0); // 11:30 IST
  const q = { from: '22:00', to: '07:00', tz: 'Asia/Kolkata' };
  const ring = (now: number) => announcement(item({ trigger: 'arrive' }), { muted: false, quiet: inQuietHours(q, now) });
  assert.equal(ring(night).chime, null);
  assert.deepEqual(ring(day).chime, { kind: 'arrive', watched: false });
});

/** memory is a Storage stand-in. */
function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

test('the mute switch survives a reload, and refused storage never throws', () => {
  const s = memory();
  assert.equal(readMuted(() => s), false);
  writeMuted(true, () => s);
  assert.equal(s.data.get(MUTE_KEY), '1');
  assert.equal(readMuted(() => s), true);
  writeMuted(false, () => s);
  assert.equal(s.data.has(MUTE_KEY), false);
  assert.equal(readMuted(() => s), false);
  const blocked = () => {
    throw new Error('SecurityError');
  };
  assert.equal(readMuted(blocked), false);
  assert.doesNotThrow(() => writeMuted(true, blocked));
  assert.equal(readMuted(() => null), false);
  assert.doesNotThrow(() => writeMuted(true, () => null));
});
