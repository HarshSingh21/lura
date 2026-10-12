import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { keys, useOverview } from '@/api/hooks';

import { useTracking, type TrackingStatus } from './useTracking';

/**
 * The GPS readout of this device's own publishing, for whichever screen wants
 * to show it (the Live rail does).
 */
export const useGpsStatus = create<TrackingStatus>(() => ({}));

/**
 * usePublishing keeps this device publishing on every screen of the app.
 *
 * It belongs to the app layout, next to the live socket, rather than to the
 * Live map: a person who switches to Notes to write "buy milk" has not stopped
 * moving, and the people watching them must not see them freeze. The switch
 * itself (`trackingEnabled`) is in the store, so the Live rail still turns it
 * on and off.
 */
export function usePublishing(): void {
  const { data } = useOverview();
  const qc = useQueryClient();
  const status = useTracking({
    // This device publishes as the first device in the workspace. A real
    // multi-device setup would pick explicitly; Phase 1 has one phone.
    deviceId: data?.devices[0]?.id ?? '',
    userId: data?.user.id,
    // A signed-in browser registers a device of its own on its first fix; the
    // overview has to be re-read for that device's marker to appear.
    onRegistered: () => {
      void qc.invalidateQueries({ queryKey: keys.overview });
      void qc.invalidateQueries({ queryKey: keys.devices });
    },
  });
  useEffect(() => {
    useGpsStatus.setState(status, true);
  }, [status]);
}
