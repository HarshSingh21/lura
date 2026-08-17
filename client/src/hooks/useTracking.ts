import { useEffect, useRef } from 'react';
import * as Location from 'expo-location';

import { request } from '@/api/client';
import { useStore } from '@/state/store';

/**
 * Foreground location publishing: this device becomes a tracked device.
 *
 * HLD §14 and §16 are explicit that Phase 1 is foreground-only and that
 * background tracking needs the mobile app plus OS-governed permissions — so this
 * hook does exactly the honest thing and stops when the app is backgrounded.
 *
 * Fixes are posted to /pub with an explicit `speedMps` and a client sequence
 * number, which is what lets the server dedupe a retried fix without trusting the
 * device clock (HLD §5.2).
 */

export type TrackingOptions = {
  deviceId: string;
  /** Distance in metres that must pass before a new fix is sent. */
  distanceIntervalM?: number;
  /** Upper bound on how often to send, even when moving fast. */
  minIntervalMs?: number;
};

export function useTracking(opts: TrackingOptions) {
  const enabled = useStore((s) => s.trackingEnabled);
  const setTracking = useStore((s) => s.setTracking);
  const pushToast = useStore((s) => s.pushToast);
  const seq = useRef(0);
  const lastSent = useRef(0);

  useEffect(() => {
    if (!enabled || !opts.deviceId) return;

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    const minInterval = opts.minIntervalMs ?? 5_000;

    const publish = async (position: Location.LocationObject) => {
      const now = Date.now();
      if (now - lastSent.current < minInterval) return;
      lastSent.current = now;
      seq.current += 1;

      try {
        await request(`/pub?device=${encodeURIComponent(opts.deviceId)}`, {
          method: 'POST',
          body: {
            _type: 'location',
            lat: position.coords.latitude,
            lon: position.coords.longitude,
            tst: Math.floor(position.timestamp / 1000),
            acc: position.coords.accuracy ?? undefined,
            alt: position.coords.altitude ?? undefined,
            cog: position.coords.heading ?? undefined,
            // Exact m/s, avoiding the km/h round-trip OwnTracks clients need.
            speedMps: Math.max(0, position.coords.speed ?? 0),
            seq: seq.current,
          },
        });
      } catch (err) {
        // A failed fix is not worth a toast every 5 seconds; the next one will
        // very likely succeed, and the connection indicator already shows trouble.
        console.warn('[lura] publishing a fix failed', err);
      }
    };

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (status !== 'granted') {
        setTracking(false);
        pushToast({
          kind: 'error',
          title: 'Location permission denied',
          body: 'Lura can still show your places and history, but it cannot publish this device’s position.',
        });
        return;
      }

      // Send one fix immediately so the marker appears without waiting for movement.
      try {
        const first = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) await publish(first);
      } catch {
        // No fix yet (indoors, cold start); the watcher below will catch up.
      }

      subscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.Balanced,
          distanceInterval: opts.distanceIntervalM ?? 25,
          timeInterval: minInterval,
        },
        (position) => {
          void publish(position);
        },
      );
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, opts.deviceId, opts.distanceIntervalM, opts.minIntervalMs, pushToast, setTracking]);
}
