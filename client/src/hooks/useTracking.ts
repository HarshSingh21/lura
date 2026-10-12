import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';

import { request } from '@/api/client';
import type { Device } from '@/api/types';
import { useStore } from '@/state/store';

import { FixGate, ownTracksPayload, type RawFix } from './fixGate';
import { Publisher, type DeviceCredential } from './publisher';

/**
 * Foreground location publishing: this device becomes a tracked device.
 *
 * HLD §14 and §16 are explicit that Phase 1 is foreground-only and that
 * background tracking needs the mobile app plus OS-governed permissions — so this
 * hook does exactly the honest thing and stops when the app is backgrounded.
 *
 * Accuracy is the product here: the person watching sees exactly what this hook
 * sends. So it asks for the best fix the platform has (high accuracy, never a
 * cached position), and every fix passes through FixGate (fixGate.ts), which
 * drops duplicates and rough guesses and paces sending to one fix per 2 s while
 * moving and one per 30 s while still.
 *
 * On the web it talks to `navigator.geolocation` directly: expo-location's web
 * shim calls watchPosition without `enableHighAccuracy` and reads
 * `getCurrentPosition` with `maximumAge: Infinity`, which on a laptop means a
 * Wi-Fi guess hundreds of metres off, served from cache.
 *
 * Fixes are posted to /pub with OwnTracks fields (acc, cog, vel), an exact
 * `speedMps` and a client sequence number, which is what lets the server dedupe a
 * retried fix without trusting the device clock (HLD §5.2). Which credential
 * they are posted with is publisher.ts's job: a signed-in browser registers a
 * device of its own the first time, because /pub never accepts a session token.
 */

export type TrackingOptions = {
  /** The device the session publishes as under the static development token. */
  deviceId: string;
  /** The signed-in user; a registered device credential is remembered per user. */
  userId?: string;
  /** Called after this app registered a device of its own, so the caller can refetch. */
  onRegistered?: () => void;
};

/* ------------------------------------------------------------ credentials */

const credKey = (userId: string) => `lura.pubcred.${userId.replace(/[^A-Za-z0-9._-]/g, '_')}`;

async function loadCred(userId: string): Promise<DeviceCredential | null> {
  try {
    const raw =
      Platform.OS === 'web'
        ? typeof localStorage !== 'undefined'
          ? localStorage.getItem(credKey(userId))
          : null
        : await SecureStore.getItemAsync(credKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeviceCredential>;
    return parsed.deviceId && parsed.token ? { deviceId: parsed.deviceId, token: parsed.token } : null;
  } catch {
    return null;
  }
}

async function saveCred(userId: string, cred: DeviceCredential | null): Promise<void> {
  const key = credKey(userId);
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return;
      if (cred) localStorage.setItem(key, JSON.stringify(cred));
      else localStorage.removeItem(key);
      return;
    }
    if (cred) await SecureStore.setItemAsync(key, JSON.stringify(cred));
    else await SecureStore.deleteItemAsync(key);
  } catch {
    // Losing it costs one extra device registration, not a fix.
  }
}

/** thisDeviceName is what the registered device is called in the device list. */
function thisDeviceName(): { name: string; kind: string } {
  if (Platform.OS === 'web') return { name: 'Web browser', kind: 'browser' };
  return { name: Platform.OS === 'ios' ? 'iPhone' : 'Android phone', kind: 'phone' };
}

function makePublisher(userId: string): Publisher {
  return new Publisher({
    post: (path, body, bearerToken) => request(path, { method: 'POST', body, bearerToken }),
    register: async () => {
      const res = await request<{ device: Device; pubToken: string }>('/api/v1/devices', {
        method: 'POST',
        body: thisDeviceName(),
      });
      return { deviceId: res.device.id, token: res.pubToken };
    },
    load: () => loadCred(userId),
    save: (cred) => saveCred(userId, cred),
  });
}

/** TrackingStatus is what the UI shows about this device's own GPS. */
export type TrackingStatus = {
  /** Accuracy radius of the newest raw fix, metres (whether or not it was sent). */
  accuracyM?: number;
  /** When the newest fix was published, ms since epoch. */
  lastSentAt?: number;
  /** Why the newest fix was held back, when it was. */
  held?: 'duplicate' | 'inaccurate' | 'throttled' | 'stale';
  /** Whether the gate currently considers this device moving. */
  moving?: boolean;
  /** The device fixes are actually published as (a registered browser, for a signed-in session). */
  deviceId?: string;
};

type BatteryManagerLike = { level: number };

/** webBattery reads the battery level where the browser exposes it (Chromium). */
async function webBattery(): Promise<number | undefined> {
  try {
    const nav = navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> };
    if (typeof nav.getBattery !== 'function') return undefined;
    const battery = await nav.getBattery();
    return Number.isFinite(battery.level) ? battery.level * 100 : undefined;
  } catch {
    return undefined;
  }
}

export function useTracking(opts: TrackingOptions): TrackingStatus {
  const enabled = useStore((s) => s.trackingEnabled);
  const setTracking = useStore((s) => s.setTracking);
  const pushToast = useStore((s) => s.pushToast);
  const seq = useRef(0);
  const [status, setStatus] = useState<TrackingStatus>({});
  // Held in a ref so a new callback identity does not restart the GPS watch.
  const registered = useRef(opts.onRegistered);
  useEffect(() => {
    registered.current = opts.onRegistered;
  });
  const userKey = opts.userId ?? 'local';

  useEffect(() => {
    // A brand-new account has no device yet; the publisher registers one.
    if (!enabled || (!opts.deviceId && !opts.userId)) return;

    let cancelled = false;
    const gate = new FixGate();
    const publisher = makePublisher(userKey);
    let stop: (() => void) | null = null;

    const denied = () => {
      setTracking(false);
      pushToast({
        kind: 'error',
        title: 'Location permission denied',
        body: 'Lura can still show your places and history, but it cannot publish this device’s position.',
      });
    };

    const handle = async (fix: RawFix, altitudeM?: number) => {
      if (cancelled) return;
      const decision = gate.offer(fix, Date.now());
      if (!decision.send) {
        // The accuracy readout tracks every fix, so a held "inaccurate" fix is
        // visible as such rather than looking like a frozen GPS.
        setStatus((s) =>
          s.accuracyM === fix.accuracyM && s.held === decision.reason ? s : { ...s, accuracyM: fix.accuracyM, held: decision.reason },
        );
        return;
      }
      seq.current += 1;
      const battery = Platform.OS === 'web' ? await webBattery() : undefined;
      setStatus((s) => ({ ...s, accuracyM: fix.accuracyM, lastSentAt: Date.now(), moving: decision.moving, held: undefined }));
      try {
        const result = await publisher.publish(ownTracksPayload(decision.fix, seq.current, { altitudeM, battery }), opts.deviceId);
        if (result.registered) registered.current?.();
        setStatus((s) => (s.deviceId === result.deviceId ? s : { ...s, deviceId: result.deviceId }));
      } catch (err) {
        // A failed fix is not worth a toast every 2 seconds; the next one will
        // very likely succeed, and the connection indicator already shows trouble.
        console.warn('[lura] publishing a fix failed', err);
      }
    };

    if (Platform.OS === 'web') {
      const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
      if (!geo) {
        denied();
        return;
      }
      const watch = () => geo.watchPosition(
        (position) => {
          const c = position.coords;
          void handle(
            {
              point: { lat: c.latitude, lon: c.longitude },
              accuracyM: c.accuracy ?? undefined,
              speedMps: c.speed ?? undefined,
              headingDeg: c.heading ?? undefined,
              ts: position.timestamp,
            },
            c.altitude ?? undefined,
          );
        },
        (error) => {
          if (cancelled) return;
          if (error.code === error.PERMISSION_DENIED) denied();
          // TIMEOUT / POSITION_UNAVAILABLE: the watch keeps running and recovers.
        },
        // maximumAge 0: never a cached fix. The timeout only bounds each attempt.
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
      );
      // One publisher per browser: every tab of the app shares this device's
      // credential, and two tabs each sending the same GPS would double the
      // fixes (and the chance of two arriving out of order). The tab holding
      // the lock publishes; another waits in line and takes over the moment
      // that tab closes, so the person never stops being visible.
      const locks = (navigator as Navigator & { locks?: LockManager }).locks;
      if (locks?.request) {
        let release: (() => void) | undefined;
        void locks
          .request(`lura-publisher:${userKey}`, () =>
            new Promise<void>((resolve) => {
              release = resolve;
              if (cancelled) {
                resolve();
                return;
              }
              const id = watch();
              stop = () => geo.clearWatch(id);
            }),
          )
          .catch(() => undefined);
        return () => {
          cancelled = true;
          stop?.();
          release?.();
        };
      }
      const watchId = watch();
      stop = () => geo.clearWatch(watchId);
      return () => {
        cancelled = true;
        stop?.();
      };
    }

    let subscription: Location.LocationSubscription | null = null;
    (async () => {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (cancelled) return;
      if (permission !== 'granted') {
        denied();
        return;
      }

      const fromExpo = (position: Location.LocationObject) =>
        handle(
          {
            point: { lat: position.coords.latitude, lon: position.coords.longitude },
            accuracyM: position.coords.accuracy ?? undefined,
            speedMps: position.coords.speed ?? undefined,
            headingDeg: position.coords.heading ?? undefined,
            ts: position.timestamp,
          },
          position.coords.altitude ?? undefined,
        );

      // The watcher delivers every fix (no distance filter); FixGate decides what
      // is worth sending, which is what keeps standing jitter off the map while a
      // walk still updates every 2 s.
      subscription = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1_000 },
        (position) => {
          void fromExpo(position);
        },
      );
      if (cancelled) subscription.remove();
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [enabled, opts.deviceId, opts.userId, userKey, pushToast, setTracking]);

  return enabled ? status : {};
}
