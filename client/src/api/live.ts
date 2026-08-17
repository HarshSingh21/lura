import { wsUrlFresh } from './client';
import type { Frame } from './types';

/**
 * The live WebSocket client.
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
 */

export type LiveStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export type LiveOptions = {
  /** Path to connect to: /ws for a user, /s/<token>/ws for a share viewer. */
  path: string;
  anonymous?: boolean;
  onFrame: (frame: Frame) => void;
  onStatus?: (status: LiveStatus) => void;
  /** Silence longer than this is treated as a dead connection. */
  idleTimeoutMs?: number;
  pingIntervalMs?: number;
  maxBackoffMs?: number;
};

export type LiveConnection = { close: () => void; status: () => LiveStatus };

export function connectLive(opts: LiveOptions): LiveConnection {
  const idleTimeoutMs = opts.idleTimeoutMs ?? 70_000;
  const pingIntervalMs = opts.pingIntervalMs ?? 25_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 30_000;

  let socket: WebSocket | null = null;
  let status: LiveStatus = 'idle';
  let attempt = 0;
  let closedByCaller = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (next: LiveStatus) => {
    if (status === next) return;
    status = next;
    opts.onStatus?.(next);
  };

  const clearTimers = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (idleTimer) clearTimeout(idleTimer);
    pingTimer = null;
    idleTimer = null;
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
    setStatus('reconnecting');
    attempt += 1;
    const base = Math.min(maxBackoffMs, 500 * 2 ** Math.min(attempt, 6));
    // Full jitter: without it, every client that dropped together comes back
    // together.
    const delay = Math.random() * base;
    reconnectTimer = setTimeout(open, delay);
  };

  function open() {
    if (closedByCaller) return;
    setStatus(attempt === 0 ? 'connecting' : 'reconnecting');

    // The token is renewed *before* the handshake rather than after a rejection: a
    // WebSocket carries its credential in the query string and cannot retry a 401
    // the way a fetch can, so an expired token would cost a full backoff cycle.
    void wsUrlFresh(opts.path, { anonymous: opts.anonymous }).then(connect, scheduleReconnect);
  }

  function connect(url: string) {
    if (closedByCaller) return;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      scheduleReconnect();
      return;
    }
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      setStatus('open');
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
      if (typeof event.data !== 'string') return;
      let frame: Frame;
      try {
        frame = JSON.parse(event.data) as Frame;
      } catch {
        return; // a frame we cannot parse is a server bug, not a reason to drop the socket
      }
      if (frame.type === 'pong') return;
      opts.onFrame(frame);
    };

    ws.onerror = () => {
      // onclose always follows; reconnect logic lives there so it runs once.
    };

    ws.onclose = () => {
      clearTimers();
      socket = null;
      if (closedByCaller) {
        setStatus('closed');
        return;
      }
      scheduleReconnect();
    };
  }

  open();

  return {
    close() {
      closedByCaller = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearTimers();
      socket?.close(1000, 'client closed');
      socket = null;
      setStatus('closed');
    },
    status: () => status,
  };
}
