import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';

import { keys, useOverview } from '@/api/hooks';
import { useStore } from '@/state/store';
import { localStorageOrNull } from '@/state/webStorage';

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
  useRememberTracking(data?.user.id);
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

/**
 * useRememberTracking keeps the publish switch across reloads, per person.
 *
 * A reload is not "stop sharing": without this the people watching would see
 * this browser freeze mid-walk until someone noticed and turned it back on. The
 * choice is stored under the signed-in user, so whoever signs in next on the
 * same browser starts with their own choice, not the previous person's.
 */
function useRememberTracking(userId: string | undefined) {
  const enabled = useStore((s) => s.trackingEnabled);
  const restoredFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!userId || Platform.OS !== 'web' || !localStorageOrNull()) return;
    const key = `lura.tracking.${userId}`;
    try {
      if (restoredFor.current !== userId) {
        restoredFor.current = userId;
        useStore.getState().setTracking(localStorage.getItem(key) === '1');
        return;
      }
      localStorage.setItem(key, enabled ? '1' : '0');
    } catch {
      // Storage refused (private mode): the switch still works for this page.
    }
  }, [userId, enabled]);
}

/**
 * useQuietHoursSync keeps the store's copy of the viewer's quiet hours in step
 * with their account, so a chime knows whether it may sound (notify/quiet.ts).
 */
export function useQuietHoursSync(): void {
  const { data } = useOverview();
  const user = data?.user;
  useEffect(() => {
    useStore.getState().setQuietHours(user ? { from: user.quietFrom, to: user.quietTo, tz: user.tz } : null);
  }, [user]);
}
