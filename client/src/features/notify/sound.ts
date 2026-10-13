import { Platform, Vibration } from 'react-native';

import { MASTER, PEAK, chimeGate, chimeTones, readMuted, vibrationPattern, writeMuted, type Tone } from './chimes';
import type { ChimeKind } from './model';

/**
 * Notification sounds, synthesised rather than shipped.
 *
 * A chime is a few sine partials under an envelope, so there is no audio asset to
 * bundle, license or cache, and each trigger can have its own shape: arrive
 * rises, leave falls, pass-by is a quick flick and dwell is a soft double knock —
 * distinct enough to tell apart without looking at the screen. A crossing by
 * someone you watch rings the same trigger's chime with a bell shimmer on top, so
 * "Nishtha arrived" and "Nishtha left" still sound different.
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

type AudioContextCtor = new () => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
/** Chimes closer than MIN_GAP_MS apart are dropped (chimes.ts). */
const mayPlay = chimeGate();

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
 * playChime plays one kind's chime, with the watch bell when `watched`. It never
 * throws: a notification whose sound failed is still a notification.
 */
export function playChime(kind: ChimeKind, opts: { watched?: boolean } = {}): void {
  if (!mayPlay(Date.now())) return;

  if (Platform.OS !== 'web') {
    try {
      Vibration.vibrate(vibrationPattern(kind, opts.watched));
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
    for (const tone of chimeTones(kind, opts.watched)) note(c, master, tone, start);
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
  return readMuted(webStorage);
}

export function saveMuted(muted: boolean): void {
  writeMuted(muted, webStorage);
}
