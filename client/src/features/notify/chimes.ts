import type { ChimeKind } from './model';

/**
 * What each chime is made of, and the rules that keep chimes safe — the data
 * half of sound.ts, free of React Native and the Web Audio API so `node --test`
 * runs it (chimes.clientgeo.test.mts).
 *
 * Arrive rises, leave falls, pass-by is a quick flick and dwell is a soft
 * double knock. A crossing by someone you watch rings the same trigger's chime
 * with a bell shimmer after it, so "Nishtha arrived" and "Nishtha left" still
 * sound different from each other and from my own crossings.
 */

export type Tone = {
  /** Hz */
  freq: number;
  /** Seconds after the chime starts. */
  at: number;
  /** Seconds the note rings for. */
  dur: number;
  /** 0..1 relative to the chime's peak. */
  gain?: number;
};

export const TONES: Record<ChimeKind, Tone[]> = {
  // C6 → G6: a rising fifth, "you're here".
  arrive: [
    { freq: 1046.5, at: 0, dur: 0.32 },
    { freq: 1568, at: 0.12, dur: 0.5 },
  ],
  // G5 → C5: the same interval falling.
  leave: [
    { freq: 784, at: 0, dur: 0.32 },
    { freq: 523.25, at: 0.13, dur: 0.5 },
  ],
  // E6 A6 E7: a quick upward flick, over before you notice it started.
  passby: [
    { freq: 1318.5, at: 0, dur: 0.14, gain: 0.8 },
    { freq: 1760, at: 0.07, dur: 0.14, gain: 0.8 },
    { freq: 2637, at: 0.14, dur: 0.28, gain: 0.6 },
  ],
  // A5 twice, low and soft: "still here".
  dwell: [
    { freq: 880, at: 0, dur: 0.28, gain: 0.75 },
    { freq: 880, at: 0.24, dur: 0.4, gain: 0.75 },
  ],
};

/**
 * The watch bell: two soft inharmonic partials, struck with the trigger's own
 * notes, that read as "this is about someone you watch". They come after the
 * trigger's tones in the schedule so the chime still starts on its trigger's note.
 */
export const WATCH_BELL: Tone[] = [
  { freq: 2650, at: 0.02, dur: 0.3, gain: 0.16 },
  { freq: 3540, at: 0.2, dur: 0.35, gain: 0.12 },
];

export const VIBRATION: Record<ChimeKind, number[]> = {
  arrive: [0, 40, 70, 60],
  leave: [0, 60, 70, 40],
  passby: [0, 25],
  dwell: [0, 35, 120, 35],
};

/** A watched person's crossing ends on one extra short buzz. */
export const WATCH_BUZZ = [60, 30];

/** Peak per note, before the master gain. Low on purpose: chimes overlap. */
export const PEAK = 0.22;
export const MASTER = 0.6;
/** Chimes closer than this are dropped, so a burst of crossings is one sound. */
export const MIN_GAP_MS = 350;

/** chimeTones is the note schedule for one chime on web. */
export function chimeTones(kind: ChimeKind, watched = false): Tone[] {
  return watched ? [...TONES[kind], ...WATCH_BELL] : TONES[kind];
}

/** vibrationPattern is the same chime on a phone, which has no audio module. */
export function vibrationPattern(kind: ChimeKind, watched = false): number[] {
  return watched ? [...VIBRATION[kind], ...WATCH_BUZZ] : VIBRATION[kind];
}

/**
 * chimeGate drops a chime that would start within MIN_GAP_MS of the last one
 * it let through. Returns whether this one may play.
 */
export function chimeGate(gapMs = MIN_GAP_MS): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY;
  return (now) => {
    if (now - last < gapMs) return false;
    last = now;
    return true;
  };
}

// ------------------------------------------------------------------ muting

export const MUTE_KEY = 'lura.notify.muted.v1';

type MuteStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** readMuted reads the viewer's mute switch; any storage failure means "not muted". */
export function readMuted(store: () => MuteStore | null): boolean {
  try {
    return store()?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

/** writeMuted stores the switch; a refused write leaves the in-memory flag to hold for the session. */
export function writeMuted(muted: boolean, store: () => MuteStore | null): void {
  try {
    const s = store();
    if (!s) return;
    if (muted) s.setItem(MUTE_KEY, '1');
    else s.removeItem(MUTE_KEY);
  } catch {
    // Storage blocked: the in-memory flag still holds for this session.
  }
}
