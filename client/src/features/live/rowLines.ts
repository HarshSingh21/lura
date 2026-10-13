import type { Device, Place, Position } from '@/api/types';
import { latestFix, type PeerFix } from '@/features/people/peer';
import type { Peer } from '@/features/people/types';

import { deviceLine, fixTimeMs, formatAge, formatSpeed, isStale, MOVING_MPS, pingLine, speedOf, type TrailPoint } from './motion';

/**
 * What the live map and its rail say about a device, from the frames a viewer
 * holds.
 *
 * One phone is described in three places: its marker, its owner's "My devices"
 * row and, for the person it shares with, their People row. All three come from
 * here, from the same inputs (the position store and the trail buffer, fed by
 * the same frames for every viewer), so a phone on a table cannot read "Still"
 * to its owner and "Moving" to the person watching it.
 *
 * Free of React so `node --test` runs it (rowLines.clientgeo.test.mts).
 */

/** A device whose newest fix is this fresh pulses as live. */
export const LIVE_PULSE_MS = 120_000;

/**
 * rowSpeed is a device's speed: the trail's (the device's own, else derived
 * from its last two fixes) once there is a trail, else what the snapshot said.
 */
export function rowSpeed(trail: readonly TrailPoint[] | undefined, fallback: number): number {
  return trail && trail.length > 0 ? speedOf(trail) : fallback;
}

/** DeviceRow is one of my devices in "My devices". */
export type DeviceRow = { line: string; moving: boolean; speed: number; lastSeenMs?: number };

export function deviceRow(
  device: Device,
  positions: Record<string, Position>,
  trails: Record<string, TrailPoint[]>,
  places: Place[],
  now: number,
): DeviceRow {
  const live = positions[device.id];
  const speed = rowSpeed(trails[device.id], live?.speedMps ?? device.speedMps ?? 0);
  const moving = speed > MOVING_MPS;
  const lastSeenMs = live ? fixTimeMs(live) : device.lastSeen ? new Date(device.lastSeen).getTime() : undefined;
  const inside = (device.insidePlaces ?? []).map((id) => places.find((p) => p.id === id)?.name).filter(Boolean)[0];
  return { line: deviceLine({ moving, speed, inside, lastSeenMs, now }), moving, speed, lastSeenMs };
}

/** PeerRow is a connected person in the rail's People block. */
export type PeerRow = { line: string; fix?: PeerFix; fresh: boolean };

/**
 * peerRow describes a person by their freshest device, or says why there is
 * nothing to describe. A person whose switch is off has paused sharing with me:
 * a missing marker must read as that, never as a lost signal — even when the
 * store still holds their last live frames from before they paused.
 */
export function peerRow(
  peer: Peer,
  positions: Record<string, Position>,
  trails: Record<string, TrailPoint[]>,
  now: number,
): PeerRow {
  const fix = peer.sharingWithMe ? latestFix(peer, positions) : undefined;
  if (!fix) return { line: peer.sharingWithMe ? 'Sharing · no fix yet' : 'Paused sharing with you', fresh: false };
  const lastSeenMs = fix.lastSeen ? new Date(fix.lastSeen).getTime() : undefined;
  const line = pingLine({
    speed: rowSpeed(trails[fix.deviceId], fix.speedMps),
    lastSeenMs,
    battery: positions[fix.deviceId]?.battery,
    now,
  });
  return { line, fix, fresh: lastSeenMs !== undefined && Number.isFinite(lastSeenMs) && now - lastSeenMs < LIVE_PULSE_MS };
}

/** MarkerState is what a live marker shows besides where it is. */
export type MarkerState = { label: string; stale: boolean; pulse: boolean; speed: number };

/**
 * markerState: a fix older than STALE_AFTER_MS is where they *were* — hollow,
 * with how long ago in place of a speed that is no longer true; otherwise the
 * name, and the speed while moving (the same words as the rows).
 */
export function markerState(label: string, trail: readonly TrailPoint[] | undefined, fallbackSpeed: number, lastSeenMs: number | undefined, now: number): MarkerState {
  const speed = rowSpeed(trail, fallbackSpeed);
  const stale = isStale(lastSeenMs, now);
  return {
    label:
      stale && lastSeenMs !== undefined
        ? `${label} · ${formatAge(now - lastSeenMs)}`
        : speed > MOVING_MPS
          ? `${label} · ${formatSpeed(speed)}`
          : label,
    stale,
    pulse: !stale && lastSeenMs !== undefined && now - lastSeenMs < LIVE_PULSE_MS,
    speed,
  };
}
