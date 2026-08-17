import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { connectLive } from '@/api/live';
import { keys } from '@/api/hooks';
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

    const { applyPosition, applyGeoEvent, applyReminder, applyAcl, setStatus, pushToast } = useStore.getState();

    const conn = connectLive({
      path: '/ws',
      onStatus: setStatus,
      onFrame: (frame) => {
        switch (frame.type) {
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
            break;

          case 'position':
            applyPosition(frame.data);
            break;

          case 'geo':
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
