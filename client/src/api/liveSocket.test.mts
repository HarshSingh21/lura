// The live socket's session behaviour: a fresh token for every handshake,
// reconnect with backoff, `since=` for the replay, waking from sleep, the
// browser's offline signal — driven with a fake socket and node's mock timers.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';

import type { Frame } from './types.ts';
import { createLiveSocket, type LiveStatus, type SocketLike } from './liveSocket.ts';
import { wakeAction, WAKE_PROBE_MS } from './wake.ts';

class FakeSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed?: { code?: number; reason?: string };
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
  }
  // what the browser does
  open() {
    this.onopen?.({});
  }
  frame(f: Partial<Frame> & { type: string; ts?: string }) {
    this.onmessage?.({ data: JSON.stringify(f) });
  }
  drop() {
    this.onclose?.({});
  }
}

/** flush lets resolved promises (the URL resolution) run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

function harness(t: TestContext, over: { random?: () => number; failResolve?: number; offline?: boolean } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets: FakeSocket[] = [];
  const frames: Frame[] = [];
  const statuses: LiveStatus[] = [];
  const opens: boolean[] = [];
  const resolved: string[] = [];
  let tokenSeq = 0;
  let failures = over.failResolve ?? 0;
  let wake: ((ms: number) => void) | undefined;
  const net = {
    isOffline: over.offline ?? false,
    handlers: undefined as undefined | { offline: () => void; online: () => void },
  };

  const conn = createLiveSocket(
    {
      path: '/ws',
      onFrame: (f) => frames.push(f),
      onStatus: (s) => statuses.push(s),
      onOpen: (resumed) => opens.push(resumed),
      idleTimeoutMs: 70_000,
      pingIntervalMs: 25_000,
      maxBackoffMs: 30_000,
    },
    {
      // Like wsUrlFresh: every handshake asks the session for a token, which
      // renews it first when it is about to expire.
      resolveUrl: async (path) => {
        if (failures > 0) {
          failures--;
          throw new Error('token renewal failed');
        }
        const url = `ws://lura.test${path}${path.includes('?') ? '&' : '?'}access_token=t${++tokenSeq}`;
        resolved.push(url);
        return url;
      },
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      onWake: (fn) => {
        wake = fn;
        return () => (wake = undefined);
      },
      wakeAction,
      wakeProbeMs: WAKE_PROBE_MS,
      network: {
        offline: () => net.isOffline,
        listen: (h) => {
          net.handlers = h;
          return () => (net.handlers = undefined);
        },
      },
      random: over.random ?? (() => 0),
    },
  );
  t.after(() => conn.close());
  return {
    conn,
    sockets,
    frames,
    statuses,
    opens,
    resolved,
    net,
    wake: (ms: number) => wake?.(ms),
    hasWake: () => wake !== undefined,
    last: () => sockets[sockets.length - 1]!,
    tick: (ms: number) => t.mock.timers.tick(ms),
  };
}

const sinceOf = (url: string) => new URL(url).searchParams.get('since');
const tokenOf = (url: string) => new URL(url).searchParams.get('access_token');

test('every handshake asks for a token, and a reconnect carries since= the newest frame', async (t) => {
  const h = harness(t);
  await flush();
  assert.equal(h.sockets.length, 1);
  assert.equal(sinceOf(h.last().url), null, 'the first connect replays nothing');
  assert.equal(tokenOf(h.last().url), 't1');
  h.last().open();
  assert.deepEqual(h.opens, [false]);

  h.last().frame({ type: 'hello', ts: '2026-10-13T10:00:00Z', data: { viewerId: 'u' } as never });
  h.last().frame({ type: 'geo', ts: '2026-10-13T10:00:05.250Z', data: {} as never });
  // A frame stamped earlier (the hub's replay order) must not move since= back.
  h.last().frame({ type: 'position', ts: '2026-10-13T10:00:01Z', data: {} as never });
  h.last().frame({ type: 'pong', ts: '2026-10-13T10:00:06Z' });
  assert.deepEqual(
    h.frames.map((f) => f.type),
    ['hello', 'geo', 'position'],
    'pongs are not handed to the app',
  );

  h.last().drop();
  assert.equal(h.conn.status(), 'reconnecting');
  h.tick(0);
  await flush();
  assert.equal(h.sockets.length, 2);
  assert.equal(sinceOf(h.last().url), '2026-10-13T10:00:06Z', 'pong timestamps count: they are server time too');
  assert.equal(tokenOf(h.last().url), 't2', 'the reconnect asked for a token again');
  h.last().open();
  assert.deepEqual(h.opens, [false, true], 'the replacement reports resumed');
});

test('a handshake whose token renewal fails is retried with backoff, not abandoned', async (t) => {
  const h = harness(t, { failResolve: 2, random: () => 1 });
  await flush();
  assert.equal(h.sockets.length, 0);
  assert.equal(h.conn.status(), 'reconnecting');
  h.tick(999);
  await flush();
  assert.equal(h.sockets.length, 0, 'not before the first backoff (1 s at full jitter)');
  h.tick(1);
  await flush();
  assert.equal(h.sockets.length, 0, 'second renewal failed too');
  h.tick(2000);
  await flush();
  assert.equal(h.sockets.length, 1);
  h.last().open();
  assert.equal(h.conn.status(), 'open');
});

test('backoff doubles per failed attempt up to the cap and resets once open', async (t) => {
  const h = harness(t, { random: () => 1 });
  await flush();
  const delays: number[] = [];
  for (let i = 0; i < 7; i++) {
    h.last().drop();
    let waited = 0;
    const before = h.sockets.length;
    while (h.sockets.length === before && waited < 60_000) {
      h.tick(250);
      waited += 250;
      await flush();
    }
    delays.push(waited);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  h.last().open();
  h.last().drop();
  h.tick(1000);
  await flush();
  assert.equal(h.sockets.length, 9, 'an open resets the backoff');
});

test('silence past the idle timeout replaces the socket; frames and pongs keep it', async (t) => {
  const h = harness(t);
  await flush();
  h.last().open();
  h.tick(60_000);
  h.last().frame({ type: 'pong', ts: '2026-10-13T10:00:00Z' });
  h.tick(60_000);
  assert.equal(h.last().closed, undefined, 'a pong within the window keeps it alive');
  assert.ok(h.last().sent.some((m) => m.includes('"ping"')), 'the app-level ping went out');
  h.tick(10_001);
  assert.equal(h.last().closed?.code, 4000);
  h.last().drop();
  h.tick(0);
  await flush();
  assert.equal(h.sockets.length, 2);
});

test('waking from a long sleep replaces the socket at once, and its late onclose changes nothing', async (t) => {
  const h = harness(t);
  await flush();
  const first = h.last();
  first.open();
  first.frame({ type: 'hello', ts: '2026-10-13T10:00:00Z', data: { viewerId: 'u' } as never });

  h.wake(10 * 60_000);
  await flush();
  assert.equal(first.closed?.code, 4003);
  assert.equal(h.sockets.length, 2, 'replaced without waiting for the old close');
  assert.equal(sinceOf(h.last().url), '2026-10-13T10:00:00Z');
  h.last().open();

  first.drop(); // the dead socket finally reports
  h.tick(30_000);
  await flush();
  assert.equal(h.sockets.length, 2, 'no extra reconnect from the stale socket');
  assert.equal(h.conn.status(), 'open');
});

test('waking from a short sleep probes; an answer keeps the socket, silence replaces it', async (t) => {
  const h = harness(t);
  await flush();
  h.last().open();

  h.wake(15_000);
  assert.ok(h.last().sent.some((m) => m.includes('"ping"')));
  h.last().frame({ type: 'pong', ts: '2026-10-13T10:00:00Z' });
  h.tick(WAKE_PROBE_MS + 1);
  assert.equal(h.last().closed, undefined, 'it answered');
  assert.equal(h.sockets.length, 1);

  h.wake(15_000);
  h.tick(WAKE_PROBE_MS + 1);
  await flush();
  assert.equal(h.sockets[0]!.closed?.code, 4004);
  assert.equal(h.sockets.length, 2);
});

test('offline closes the socket and waits; online reconnects at once', async (t) => {
  const h = harness(t, { random: () => 1 });
  await flush();
  h.last().open();
  h.net.handlers!.offline();
  h.net.isOffline = true;
  assert.equal(h.last().closed?.code, 4002);
  assert.equal(h.conn.status(), 'offline');
  h.tick(120_000);
  await flush();
  assert.equal(h.sockets.length, 1, 'no retries while offline');

  h.net.isOffline = false;
  h.net.handlers!.online();
  await flush();
  assert.equal(h.sockets.length, 2, 'no backoff after coming online');
});

test('closing by the caller stops everything: no reconnect, no wake handling', async (t) => {
  const h = harness(t);
  await flush();
  h.last().open();
  h.conn.close();
  assert.equal(h.last().closed?.code, 1000);
  assert.equal(h.conn.status(), 'closed');
  assert.equal(h.hasWake(), false);
  h.last().drop();
  h.tick(60_000);
  await flush();
  assert.equal(h.sockets.length, 1);
});
