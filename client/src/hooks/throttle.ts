/**
 * trailingThrottle runs `fn` at most once per `ms`. A call inside the window is
 * not dropped: it runs once when the window ends, however many calls came in
 * meanwhile. That is what a "re-read, the data changed" signal needs — the last
 * change in a burst must still be read.
 */
export function trailingThrottle(
  fn: () => void,
  ms: number,
  clock: { now: () => number; setTimeout: (f: () => void, ms: number) => unknown; clearTimeout: (t: unknown) => void } = {
    now: Date.now,
    setTimeout: (f, wait) => setTimeout(f, wait),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  },
): { call: () => void; cancel: () => void } {
  let last = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  const run = () => {
    timer = undefined;
    last = clock.now();
    fn();
  };
  return {
    call: () => {
      if (timer !== undefined) return;
      const wait = last + ms - clock.now();
      if (wait > 0) timer = clock.setTimeout(run, wait);
      else run();
    },
    cancel: () => {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
