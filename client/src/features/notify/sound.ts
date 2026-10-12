import { Platform, Vibration } from 'react-native';

import type { ChimeKind } from './model';

/**
 * Notification sounds, synthesised rather than shipped.
 *
 * A chime is a few sine partials under an envelope, so there is no audio asset to
 * bundle, license or cache, and each trigger can have its own shape: arrive
 * rises, leave falls, pass-by is a quick flick, dwell is a soft double knock and a
 * watched person is a two-tone bell — distinct enough to tell apart without
 * looking at the screen.
 *
 * Three constraints shape the code:
 *
 *   - Browsers refuse to start audio before a user gesture. `installAudioUnlock`
 *     resumes the context on the first pointer or key press, so a reminder that
 *     fires ten minutes later can actually be heard.
 *   - Volume safety. Every note is enveloped (no clicks), peaks well below full
 *     scale and passes through one master gain, so overlapping chimes cannot sum
 *     into something loud. Chimes closer than MIN_GAP_MS apart are dropped.
 *   - Native has no audio module installed (expo-audio would need a rebuild), so a
 *     phone gets a short vibration pattern per kind from React Native's built-in
 *     Vibration API instead.
 */

type Tone = {
  /** Hz */
  freq: number;
  /** Seconds after the chime starts. */
  at: number;
  /** Seconds the note rings for. */
  dur: number;
  /** 0..1 relative to the chime's peak. */
  gain?: number;
};

const TONES: Record<ChimeKind, Tone[]> = {
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
  // B5 / E6 bell with an inharmonic shimmer: someone you watch moved.
  watch: [
    { freq: 987.8, at: 0, dur: 0.7 },
    { freq: 2650, at: 0, dur: 0.25, gain: 0.18 },
    { freq: 1318.5, at: 0.18, dur: 0.85 },
    { freq: 3540, at: 0.18, dur: 0.25, gain: 0.15 },
  ],
};

const VIBRATION: Record<ChimeKind, number[]> = {
  arrive: [0, 40, 70, 60],
  leave: [0, 60, 70, 40],
  passby: [0, 25],
  dwell: [0, 35, 120, 35],
  watch: [0, 50, 60, 50, 60, 80],
};

/** Peak per note, before the master gain. Low on purpose: chimes overlap. */
const PEAK = 0.22;
const MASTER = 0.6;
const MIN_GAP_MS = 350;

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let lastPlayed = 0;

function audioContextCtor(): AudioContextCtor | null {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = MASTER;
    master.connect(ctx.destination);
  } catch {
    ctx = null;
    master = null;
  }
  return ctx;
}

/** audioUnlocked reports whether the browser will actually let a chime play. */
export function audioUnlocked(): boolean {
  if (Platform.OS !== 'web') return true;
  return ctx?.state === 'running';
}

let unlockInstalled = false;

/**
 * installAudioUnlock arms the context on the first user gesture. Safe to call
 * repeatedly; it removes its own listeners once audio is running.
 */
export function installAudioUnlock(): void {
  if (unlockInstalled || Platform.OS !== 'web' || typeof window === 'undefined') return;
  unlockInstalled = true;
  const events = ['pointerdown', 'keydown', 'touchend'] as const;
  const unlock = () => {
    const c = context();
    if (!c) return;
    const done = () => {
      if (c.state === 'running') for (const e of events) window.removeEventListener(e, unlock, true);
    };
    if (c.state === 'suspended') void c.resume().then(done, () => undefined);
    else done();
  };
  for (const e of events) window.addEventListener(e, unlock, true);
}

/**
 * playChime plays one kind's chime. It never throws: a notification whose sound
 * failed is still a notification.
 */
export function playChime(kind: ChimeKind): void {
  const now = Date.now();
  if (now - lastPlayed < MIN_GAP_MS) return;
  lastPlayed = now;

  if (Platform.OS !== 'web') {
    try {
      Vibration.vibrate(VIBRATION[kind]);
    } catch {
      // A device without a vibrator is fine.
    }
    return;
  }

  const c = context();
  if (!c || !master) return;
  try {
    if (c.state === 'suspended') void c.resume().catch(() => undefined);
    const start = c.currentTime + 0.02;
    for (const tone of TONES[kind]) note(c, master, tone, start);
  } catch {
    // Autoplay policy or a closed context: stay silent rather than fail the toast.
  }
}

function note(c: AudioContext, out: AudioNode, tone: Tone, start: number) {
  const t0 = start + tone.at;
  const peak = PEAK * (tone.gain ?? 1);
  const osc = c.createOscillator();
  const env = c.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(tone.freq, t0);
  // 8 ms attack (no click), then an exponential tail — how a struck bell decays.
  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + tone.dur);
  osc.connect(env);
  env.connect(out);
  osc.start(t0);
  osc.stop(t0 + tone.dur + 0.05);
  osc.onended = () => {
    osc.disconnect();
    env.disconnect();
  };
}

// ------------------------------------------------------------------ muting

const MUTE_KEY = 'lura.notify.muted.v1';

function webStorage(): Storage | null {
  if (Platform.OS !== 'web') return null;
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** loadMuted reads the viewer's mute preference; native keeps it for the session only. */
export function loadMuted(): boolean {
  try {
    return webStorage()?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveMuted(muted: boolean): void {
  try {
    const storage = webStorage();
    if (!storage) return;
    if (muted) storage.setItem(MUTE_KEY, '1');
    else storage.removeItem(MUTE_KEY);
  } catch {
    // Storage blocked: the in-memory flag still holds for this session.
  }
}
