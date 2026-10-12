/**
 * When to renew an access token.
 *
 * Kept free of imports so it is tested with plain `node --test` (refresh.test.mts):
 * the rule decides whether a session quietly outlives its tokens or hammers
 * Keycloak, and both failures are invisible until someone watches the network.
 */

/** Renew this long before expiry, so a slow network still beats the deadline. */
export const REFRESH_MARGIN_MS = 60_000;
/** Floor on the renewal timer, so a short-lived token cannot spin the refresh loop. */
export const MIN_REFRESH_DELAY_MS = 5_000;

/**
 * refreshMarginMs is how long before expiry a token of this lifetime is renewed:
 * a minute, or a quarter of the lifetime when that is shorter.
 *
 * A fixed minute is right for the realm's 15-minute tokens and wrong for short
 * ones: a 60 s token would be "expiring" from the moment it was issued, so every
 * socket handshake refreshed again and the timer fired every five seconds.
 */
export function refreshMarginMs(lifetimeMs: number): number {
  if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) return REFRESH_MARGIN_MS;
  return Math.min(REFRESH_MARGIN_MS, lifetimeMs / 4);
}

/** refreshDelayMs is when to schedule the renewal of a token expiring at `expiresAt`. */
export function refreshDelayMs(expiresAt: number, lifetimeMs: number, now: number): number {
  return Math.max(MIN_REFRESH_DELAY_MS, expiresAt - now - refreshMarginMs(lifetimeMs));
}

/** isExpiring says whether a token must be renewed before it is used for a handshake. */
export function isExpiring(expiresAt: number | undefined, lifetimeMs: number, now: number): boolean {
  return expiresAt === undefined || expiresAt - now < refreshMarginMs(lifetimeMs);
}
