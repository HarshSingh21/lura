import { wsUrlFresh } from './client';
import { createLiveSocket, type LiveConnection, type LiveOptions, type NetworkEvents, type SocketLike } from './liveSocket';
import { onWake, wakeAction, WAKE_PROBE_MS } from './wake';

export type { LiveConnection, LiveOptions, LiveStatus } from './liveSocket';

/**
 * The live WebSocket client, bound to this platform: the API client's URL
 * builder (which renews the token before the handshake), the global WebSocket,
 * the sleep detector and the browser's online/offline events. The behaviour —
 * backoff, heartbeat, replay on reconnect, waking — is in liveSocket.ts.
 */
export function connectLive(opts: LiveOptions): LiveConnection {
  return createLiveSocket(opts, {
    resolveUrl: (path, o) => wsUrlFresh(path, o),
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    onWake,
    wakeAction,
    wakeProbeMs: WAKE_PROBE_MS,
    network: networkEvents(),
  });
}

/**
 * networkEvents wraps the browser's online/offline signal, where there is one.
 * React Native has no `window` events (and NetInfo is a native module this app
 * does not ship), so there the socket relies on its heartbeat alone.
 */
function networkEvents(): NetworkEvents | undefined {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
  if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return undefined;
  return {
    offline: () => navigator.onLine === false,
    listen: ({ offline, online }) => {
      window.addEventListener('offline', offline);
      window.addEventListener('online', online);
      return () => {
        window.removeEventListener('offline', offline);
        window.removeEventListener('online', online);
      };
    },
  };
}
