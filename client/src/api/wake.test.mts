import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createWakeWatcher,
  SERVER_DROPS_AFTER_MS,
  sleptMs,
  WAKE_CHECK_MS,
  WAKE_DRIFT_MS,
  WAKE_GAP_MS,
  wakeAction,
} from './wake.ts';

const T = 1_800_000_000_000;

test('awake: both clocks move together, nothing is reported', () => {
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + 1000, mono: 1000 }), 0);
  // A little jitter between the clocks is not a sleep.
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + 1500, mono: 1010 }), 0);
});

test('a throttled background tab is not a sleep', () => {
  // Chrome aligns a hidden tab's timers to a minute: both clocks see the late tick.
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + 61_000, mono: 61_000 }), 0);
});

test('a laptop sleep: the wall clock jumped, the monotonic one did not', () => {
  // Three minutes asleep; the tick came a second after the previous one by the monotonic clock.
  assert.equal(sleptMs({ wall: T, mono: 5000 }, { wall: T + 181_000, mono: 6000 }), 180_000);
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + 1000 + WAKE_DRIFT_MS, mono: 1000 }), WAKE_DRIFT_MS);
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + WAKE_DRIFT_MS, mono: 1000 }), 0);
});

test('a frozen page: a tick far later than its period by both clocks', () => {
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + 200_000, mono: 200_000 }), 200_000 - WAKE_CHECK_MS);
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T + WAKE_GAP_MS, mono: WAKE_GAP_MS }), 0);
});

test('the wall clock set back is not a sleep', () => {
  assert.equal(sleptMs({ wall: T, mono: 0 }, { wall: T - 3_600_000, mono: 1000 }), 0);
});

test('the watcher runs only while someone listens and tells every listener', () => {
  let wall = T;
  let mono = 0;
  let running = 0;
  let fn: (() => void) | undefined;
  const w = createWakeWatcher({
    wall: () => wall,
    mono: () => mono,
    setInterval: (f) => {
      running += 1;
      fn = f;
      return running;
    },
    clearInterval: () => {
      running -= 1;
      fn = undefined;
    },
  });
  const heard: number[][] = [[], []];
  const stopA = w.onWake((ms) => heard[0].push(ms));
  const stopB = w.onWake((ms) => {
    heard[1].push(ms);
    throw new Error('a listener that fails');
  });
  assert.equal(running, 1);
  wall += 1000;
  mono += 1000;
  fn?.();
  wall += 120_000;
  mono += 1000;
  fn?.();
  assert.deepEqual(heard, [[119_000], [119_000]]);
  // Reported once: the next tick compares against the woken sample.
  wall += 1000;
  mono += 1000;
  fn?.();
  assert.deepEqual(heard[0], [119_000]);
  stopA();
  assert.equal(running, 1);
  stopB();
  assert.equal(running, 0);
});

test('on waking, an open socket is replaced when the server must have dropped it, else probed', () => {
  assert.equal(wakeAction(180_000, 'open'), 'reconnect');
  assert.equal(wakeAction(SERVER_DROPS_AFTER_MS, 'open'), 'reconnect');
  assert.equal(wakeAction(15_000, 'open'), 'probe');
  assert.equal(wakeAction(180_000, 'backoff'), 'retry');
  assert.equal(wakeAction(180_000, 'offline'), 'none');
  assert.equal(wakeAction(180_000, 'connecting'), 'none');
  assert.equal(wakeAction(180_000, 'closed'), 'none');
  assert.equal(wakeAction(0, 'open'), 'none');
});
