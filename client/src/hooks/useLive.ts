import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { connectLive } from '@/api/live';
import { keys } from '@/api/hooks';
import type { Overview, Position } from '@/api/types';
import { useTrails } from '@/features/live/trails';
import { useStore } from '@/state/store';

/**
 * Binds the live socket to the app's state.
 *
 * The division of labour is the point: positions go to the Zustand store (high
 * frequency, no server-side truth to reconcile), while a geo event or a reminder
 * *invalidates* the affected queries so TanStack Query re-reads them. That way a
 * fired reminder updates the note's state, the place's counters and the trigger
 * feed without this hook knowing any of those rules.
 */
export function useLive(enabled = true) {
  const qc = useQueryClient();
  const baseUrl = useStore((s) => s.connection.baseUrl);
  const token = useStore((s) => s.connection.token);

  useEffect(() => {
    if (!enabled) return;

    const { applyGeoEvent, applyReminder, applyAcl, setStatus, pushToast, setViewer } = useStore.getState();
    // Every fix also lands in the trail buffer, which is what lets a marker
    // glide, point where it is going and leave a short wake behind it.
    const { push: pushTrail, clear: clearTrails } = useTrails.getState();
    const applyPosition = (p: Position) => {
      useStore.getState().applyPosition(p);
      pushTrail(p);
    };
    // A fix from one of my own devices that the snapshot does not list (a phone
    // added on another screen, a browser that just registered itself) has no
    // marker until the overview names it; re-read it rather than wait for the
    // next poll. Throttled, so a burst of fixes costs one request.
    let lastRefetch = 0;
    const learnDevice = (p: Position) => {
      const overview = qc.getQueryData<Overview>(keys.overview);
      if (!overview || p.userId !== overview.user.id) return;
      if (overview.devices.some((d) => d.id === p.deviceId)) return;
      const now = Date.now();
      if (now - lastRefetch < 5_000) return;
      lastRefetch = now;
      void qc.invalidateQueries({ queryKey: keys.overview });
    };
    // A different server or credential is a different stream: its trails start empty.
    clearTrails();

    const conn = connectLive({
      path: '/ws',
      onStatus: setStatus,
      onOpen: (resumed) => {
        // Whatever changed while the socket was down — a peer paused, a place
        // was edited in another tab — is re-read rather than trusted.
        if (!resumed) return;
        void qc.invalidateQueries({ queryKey: keys.overview });
        void qc.invalidateQueries({ queryKey: ['people'] });
      },
      onFrame: (frame) => {
        switch (frame.type) {
          case 'hello':
            // Who "me" is, so a crossing can be told apart from a peer's.
            setViewer(frame.data.viewerId);
            break;

          case 'snapshot':
            // The snapshot exists so the map paints before the first live fix;
            // devices carry their last known point.
            for (const device of frame.data.devices ?? []) {
              if (!device.lastPoint || !device.lastSeen) continue;
              applyPosition({
                deviceId: device.id,
                userId: device.userId,
                recvTs: device.lastSeen,
                deviceTs: device.lastSeen,
                point: device.lastPoint,
                accuracyM: 0,
                speedMps: device.speedMps ?? 0,
                altitudeM: 0,
                headingDeg: 0,
                battery: device.battery ?? 0,
                seq: 0,
              });
            }
            // The people sharing with me, where each of their devices last was:
            // on a reconnect this replaces wherever they were when it dropped.
            for (const peer of frame.data.peers ?? []) {
              for (const device of peer.devices ?? []) {
                if (!device.point || !device.lastSeen) continue;
                applyPosition({
                  deviceId: device.id,
                  userId: peer.userId,
                  recvTs: device.lastSeen,
                  deviceTs: device.lastSeen,
                  point: device.point,
                  accuracyM: 0,
                  speedMps: device.speedMps ?? 0,
                  altitudeM: 0,
                  headingDeg: 0,
                  battery: 0,
                  seq: 0,
                });
              }
            }
            break;

          case 'position':
            applyPosition(frame.data);
            learnDevice(frame.data);
            break;

          case 'geo':
            // Toast, chime and notification-centre entry happen in the store,
            // deduped against the notify frame for the same crossing.
            applyGeoEvent(frame.data);
            // A geofence event can complete notes and change place counters.
            void qc.invalidateQueries({ queryKey: keys.overview });
            void qc.invalidateQueries({ queryKey: keys.events });
            break;

          case 'notify':
            applyReminder(frame.data);
            void qc.invalidateQueries({ queryKey: ['notes'] });
            break;

          case 'acl':
            applyAcl(frame.data.action, frame.data.reason);
            // A grant or revoke changes what the sharing screen and banner show.
            void qc.invalidateQueries({ queryKey: keys.shares });
            void qc.invalidateQueries({ queryKey: keys.overview });
            // So does a connection changing on the other side — an invitation
            // accepted, a switch paused — which the People screen must show now,
            // not at its next 30 s poll.
            void qc.invalidateQueries({ queryKey: ['people'] });
            break;

          case 'closing':
            pushToast({ kind: 'info', title: 'Server restarting', body: frame.data?.reason });
            break;

          case 'error':
            pushToast({ kind: 'error', title: 'Live connection error', body: frame.data?.error });
            break;

          default:
            break;
        }
      },
    });

    return () => conn.close();
    // Reconnect when the server address or credential changes: it is a different
    // deployment, not the same stream.
  }, [enabled, baseUrl, token, qc]);
}
