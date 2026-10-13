import assert from 'node:assert/strict';
import { test } from 'node:test';

import { trailingThrottle } from './throttle.ts';

function fakeClock() {
  let t = 1_000_000;
  const timers: { at: number; f: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    setTimeout: (f: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: t + ms, f, id });
      return id;
    },
    clearTimeout: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((y) => y.at <= t)) {
        timers.splice(timers.indexOf(x), 1);
        x.f();
      }
    },
  };
}

test('a call inside the window runs once when the window ends, not never', () => {
  const clock = fakeClock();
  let runs = 0;
  const th = trailingThrottle(() => (runs += 1), 5_000, clock);
  th.call(); // my browser registers itself: re-read now
  assert.equal(runs, 1);
  clock.advance(2_000);
  th.call(); // her tablet, two seconds later
  th.call(); // and its next fix
  assert.equal(runs, 1);
  clock.advance(2_999);
  assert.equal(runs, 1);
  clock.advance(1);
  assert.equal(runs, 2, 'the tablet is learnt at the end of the window');
  clock.advance(10_000);
  assert.equal(runs, 2, 'and only once');
  th.call();
  assert.equal(runs, 3, 'a call after the window runs at once');
});

test('cancel drops a pending trailing run', () => {
  const clock = fakeClock();
  let runs = 0;
  const th = trailingThrottle(() => (runs += 1), 5_000, clock);
  th.call();
  th.call();
  th.cancel();
  clock.advance(6_000);
  assert.equal(runs, 1);
});
