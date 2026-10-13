/**
 * Noticing that the machine slept.
 *
 * A laptop asleep runs no code, and waking it tells a page nothing: no event
 * fires unless the network happened to change. Every timer simply carries on
 * with whatever it had left — browsers and React Native run timers on a
 * monotonic clock that stops during sleep — while the wall clock has jumped by
 * the length of the sleep. So after a sleep the token renewal timer is late by
 * that much (the token in hand may be dead), and the live socket's heartbeat is
 * too: the server dropped the socket when its pings went unanswered, but the
 * page still holds it as open and would only find out at its idle timeout,
 * a minute or more later, while the map silently stops moving.
 *
 * The detector ticks once a second and compares how far the wall clock and the
 * monotonic clock moved since the last tick. They move together while the
 * machine is awake — also in a throttled background tab, where both see the
 * same late tick — and apart only across a sleep (or a wall-clock change, for
 * which a renewal check and a socket probe are harmless). A tick arriving far
 * later than its period by both clocks means the page itself was frozen
 * (a frozen background tab, an app in the background on a phone), which needs
 * the same check.
 *
 * Imports nothing, so it is tested with plain `node --test` (wake.test.mts).
 */

/** How often the clocks are compared. */
export const WAKE_CHECK_MS = 1_000;
/** The wall clock running ahead of the monotonic one by this much means a sleep. */
export const WAKE_DRIFT_MS = 10_000;
/**
 * A tick this late by both clocks means the page was frozen. Above the one
 * minute to which Chrome aligns a hidden tab's timers, so ordinary background
 * throttling never counts.
 */
export const WAKE_GAP_MS = 75_000;

export type ClockSample = { wall: number; mono: number };

/**
 * sleptMs is how long the machine (or the page) was away between two samples,
 * or 0 when it was not.
 */
export function sleptMs(prev: ClockSample, next: ClockSample, intervalMs: number = WAKE_CHECK_MS): number {
  const wall = next.wall - prev.wall;
  const mono = next.mono - prev.mono;
  const drift = wall - mono;
  if (drift >= WAKE_DRIFT_MS) return drift;
  const late = mono - intervalMs;
  if (late >= WAKE_GAP_MS) return late;
  return 0;
}

/**
 * Away this long, the server has certainly dropped the socket: it pings every
 * 25 s and gives up 10 s later when no answer comes (httpapi/handlers_ws.go).
 */
export const SERVER_DROPS_AFTER_MS = 30_000;
/** After a shorter absence the socket is probed; no answer within this long means dead. */
export const WAKE_PROBE_MS = 2_500;

/** Where the live socket stands when the machine wakes. */
export type SocketState = 'open' | 'backoff' | 'connecting' | 'offline' | 'closed';

/**
 * wakeAction decides what the live socket does on waking:
 *
 *   reconnect  away long enough that the server has dropped it: replace it now;
 *   probe      a short absence: ping it, and replace it if nothing answers;
 *   retry      it was waiting out a reconnect backoff: try now instead;
 *   none       offline (the online event reconnects), mid-handshake, or closed.
 */
export function wakeAction(slept: number, state: SocketState): 'reconnect' | 'probe' | 'retry' | 'none' {
  if (slept <= 0) return 'none';
  switch (state) {
    case 'open':
      return slept >= SERVER_DROPS_AFTER_MS ? 'reconnect' : 'probe';
    case 'backoff':
      return 'retry';
    default:
      return 'none';
  }
}

export type WakeListener = (sleptMs: number) => void;

export type WakeDeps = {
  wall: () => number;
  mono: () => number;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

/**
 * createWakeWatcher is the detector with its clocks and timer passed in. The
 * interval runs only while someone listens.
 */
export function createWakeWatcher(deps: WakeDeps, intervalMs: number = WAKE_CHECK_MS) {
  const listeners = new Set<WakeListener>();
  let handle: unknown;
  let last: ClockSample | undefined;

  const tick = () => {
    const now = { wall: deps.wall(), mono: deps.mono() };
    const slept = last ? sleptMs(last, now, intervalMs) : 0;
    last = now;
    if (slept <= 0) return;
    for (const listener of [...listeners]) {
      try {
        listener(slept);
      } catch {
        // One listener's failure must not keep the others asleep.
      }
    }
  };

  return {
    onWake(listener: WakeListener): () => void {
      listeners.add(listener);
      if (handle === undefined) {
        last = { wall: deps.wall(), mono: deps.mono() };
        handle = deps.setInterval(tick, intervalMs);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && handle !== undefined) {
          deps.clearInterval(handle);
          handle = undefined;
          last = undefined;
        }
      };
    },
    /** For tests: run one comparison now. */
    tick,
  };
}

const monotonic = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();

const shared = createWakeWatcher({
  wall: () => Date.now(),
  mono: monotonic,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});

/**
 * onWake calls `listener` with how long the machine was away each time it
 * comes back from a sleep. Returns the unsubscribe.
 */
export function onWake(listener: WakeListener): () => void {
  return shared.onWake(listener);
}
