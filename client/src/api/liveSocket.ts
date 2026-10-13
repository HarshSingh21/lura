import type { Frame } from './types';
import type { SocketState } from './wake';

/**
 * The live WebSocket client, with everything it touches passed in.
 *
 * live.ts binds it to the browser (the API client's URL builder, the global
 * WebSocket, the wake detector, navigator.onLine). Keeping the logic here,
 * importing nothing at runtime, is what lets it be driven by plain
 * `node --test` (liveSocket.test.mts) with a fake socket and fake clocks.
 *
 * The server pushes; this only ever sends an application-level ping (browsers
 * cannot send WebSocket control frames themselves). Everything interesting here
 * is failure handling:
 *
 *   - Reconnect with exponential backoff and jitter. A server restart must not
 *     produce a thundering herd of reconnects from every open tab.
 *   - A heartbeat that treats silence as death. A TCP connection through a proxy
 *     can stay "open" long after it stopped delivering, and a live map that has
 *     silently stopped updating is worse than one that says it is offline.
 *   - Never surface a stale connection as healthy: status transitions are
 *     reported so the UI can show "reconnecting…".
 *   - Believe the operating system about the network. When the browser says
 *     it is offline the socket is closed and the status says so at once, rather
 *     than after an idle timeout; when it comes back the socket reconnects
 *     immediately instead of waiting out whatever backoff it had reached.
 *   - Notice a sleep. A laptop that wakes says nothing to the page, and the
 *     socket it holds was dropped by the server meanwhile; its heartbeat would
 *     find out only at the idle timeout. On waking (api/wake.ts) the socket is
 *     replaced at once, or probed when the absence was short.
 *   - Nothing that fired while away is lost: a reconnect sends `since=` (the
 *     server time of the last frame received) and the server replays the
 *     geo events and reminders published after it. The store dedupes them by
 *     event id, so overlap is harmless.
 *   - The token is renewed *before* each handshake (resolveUrl): a WebSocket
 *     carries its credential in the query string and cannot retry a 401 the
 *     way a fetch can, so an expired token would cost a full backoff cycle.
 */

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'offline' | 'closed';

export type LiveOptions = {
  /** Path to connect to: /ws for a user, /s/<token>/ws for a share viewer. */
  path: string;
  anonymous?: boolean;
  onFrame: (frame: Frame) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Called on every successful open; `resumed` is true when it replaced a lost connection. */
  onOpen?: (resumed: boolean) => void;
  /** Silence longer than this is treated as a dead connection. */
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
};

export type LiveConnection = { close: () => void; status: () => LiveStatus };

/** The part of a WebSocket this client uses. */
export type SocketLike = {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type NetworkEvents = {
  offline: () => boolean;
  listen: (h: { offline: () => void; online: () => void }) => () => void;
};

export type LiveDeps = {
  /** The socket URL for a path, with a token renewed if it was about to expire. */
  resolveUrl: (path: string, opts: { anonymous?: boolean }) => Promise<string>;
  createSocket: (url: string) => SocketLike;
  onWake: (listener: (sleptMs: number) => void) => () => void;
  wakeAction: (slept: number, state: SocketState) => 'reconnect' | 'probe' | 'retry' | 'none';
  wakeProbeMs: number;
  network?: NetworkEvents;
  /** Math.random, for the backoff jitter. */
  random?: () => number;
};

export function createLiveSocket(opts: LiveOptions, deps: LiveDeps): LiveConnection {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 70_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;
  const random = deps.random ?? Math.random;

  let socket: SocketLike | null = null;
  let status: LiveStatus = 'idle';
  let attempt = 0;
  let closedByCaller = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;
  // Server time of the newest frame received, for the replay on reconnect.
  let lastFrameTs: string | undefined;
  let opened = false;
  // The browser's own view of the network (navigator.onLine and its events).
  const net = deps.network;
  let offline = net?.offline() ?? false;

  const setStatus = (next: LiveStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (idleTimer) clearTimeout(idleTimer);
    if (probeTimer) clearTimeout(probeTimer);
    pingTimer = null;
    idleTimer = null;
    probeTimer = null;
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      // Silence past the timeout: force a reconnect rather than trusting a socket
      // the OS still calls open.
      socket?.close(4000, 'idle timeout');
    }, idleTimeoutMs);
  };

  const scheduleReconnect = () => {
    if (closedByCaller) return;
    if (offline) {
      // No network: there is nothing to retry until it comes back (onOnline).
      setStatus('offline');
      return;
    }
    setStatus('reconnecting');
    attempt += 1;
    const base = Math.min(maxBackoffMs, 500 * 2 ** Math.min(attempt, 6));
    // Full jitter: without it, every client that dropped together comes back
    // together.
    const delay = random() * base;
    reconnectTimer = setTimeout(open, delay);
  };

  function open() {
    reconnectTimer = null;
    if (closedByCaller || socket) return;
    if (offline) {
      setStatus('offline');
      return;
    }
    setStatus(opened ? 'reconnecting' : attempt === 0 ? 'connecting' : 'reconnecting');

    const path = lastFrameTs
      ? `${opts.path}${opts.path.includes('?') ? '&' : '?'}since=${encodeURIComponent(lastFrameTs)}`
      : opts.path;
    void deps.resolveUrl(path, { anonymous: opts.anonymous }).then(connect, scheduleReconnect);
  }

  function connect(url: string) {
    // The network may have gone, or come back and opened another socket, while
    // the token was being renewed.
    if (closedByCaller || offline || socket) return;

    let ws: SocketLike;
    try {
      ws = deps.createSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      setStatus('open');
      opts.onOpen?.(opened);
      opened = true;
      armIdleTimer();
      pingTimer = setInterval(() => {
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          ws.close(4001, 'ping failed');
        }
      }, pingIntervalMs);
    };

    ws.onmessage = (event) => {
      armIdleTimer();
      if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = null;
      }
      if (typeof event.data !== 'string') return;
      let frame: Frame;
      try {
        frame = JSON.parse(event.data) as Frame;
      } catch {
        return; // a frame we cannot parse is a server bug, not a reason to drop the socket
      }
      if (frame.ts && (!lastFrameTs || Date.parse(frame.ts) >= Date.parse(lastFrameTs))) lastFrameTs = frame.ts;
      if (frame.type === 'pong') return;
      opts.onFrame(frame);
    };

    ws.onerror = () => {
      // onclose always follows; reconnect logic lives there so it runs once.
    };

    ws.onclose = () => {
      if (socket !== ws) return; // an older socket closing after its replacement opened
      clearTimers();
      socket = null;
      if (closedByCaller) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    };
  }

  const unlisten = net?.listen({
    offline: () => {
      offline = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      setStatus('offline');
      // Close now: a socket the OS says has no network will not say so itself
      // until the idle timeout, and until then the map would look live.
      const ws = socket;
      socket = null;
      clearTimers();
      ws?.close(4002, 'offline');
    },
    online: () => {
      offline = false;
      if (closedByCaller || socket) return;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      attempt = 0;
      open();
    },
  });

  // replace drops the socket in hand and opens another now, without waiting
  // for the old one to finish closing: a socket whose server is gone may take
  // its close handshake's whole timeout to report onclose.
  const replace = (code: number, reason: string) => {
    const ws = socket;
    socket = null;
    clearTimers();
    ws?.close(code, reason);
    attempt = 0;
    open();
  };

  // Back from a sleep: the socket in hand is most likely dead, whatever the
  // browser thinks, and anything that fired meanwhile is waiting in the replay.
  const unwake = deps.onWake((slept) => {
    if (closedByCaller) return;
    const state = offline ? 'offline' : socket ? (status === 'open' ? 'open' : 'connecting') : reconnectTimer ? 'backoff' : 'connecting';
    switch (deps.wakeAction(slept, state)) {
      case 'reconnect':
        replace(4003, 'woke from sleep');
        break;
      case 'probe': {
        const ws = socket;
        if (!ws || probeTimer) break;
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          ws.close(4001, 'ping failed');
          break;
        }
        probeTimer = setTimeout(() => {
          probeTimer = null;
          if (socket === ws) replace(4004, 'no answer after waking');
        }, deps.wakeProbeMs);
        break;
      }
      case 'retry':
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = null;
        attempt = 0;
        open();
        break;
      default:
        break;
    }
  });

  open();

  return {
    close() {
      closedByCaller = true;
      unlisten?.();
      unwake();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimers();
      socket?.close(1000, 'client closed');
      socket = null;
      setStatus('closed');
    },
    status: () => status,
  };
}
