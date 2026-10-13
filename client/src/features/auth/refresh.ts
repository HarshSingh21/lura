/**
 * When and how to renew an access token — the policy half of the session.
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

/** A token request that has not answered in this long is treated as a network failure. */
export const REFRESH_DEADLINE_MS = 20_000;
/** A refresh that failed on the network (not on the token) is retried this often. */
export const RETRY_DELAY_MS = 30_000;
/**
 * After a 401 forces a renewal, another 401 within this long reuses the token
 * that renewal produced: a server refusing every token (a user it does not
 * know, a clock it disagrees with) must not turn each request into a refresh.
 */
export const FORCED_RENEWAL_GAP_MS = 10_000;

/**
 * withDeadline settles like `work`, or rejects after `ms`. A token request that
 * never answers would otherwise hold the in-flight refresh forever, and every
 * later request would wait on it.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, message = 'The sign-in server did not answer in time.'): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * shouldForceRenewal decides whether a 401 for `rejected` is worth a refresh.
 * Not when the session already holds a different token (someone renewed it in
 * the meantime: use that one), and not again within FORCED_RENEWAL_GAP_MS.
 */
export function shouldForceRenewal(
  rejected: string | undefined,
  current: string | undefined,
  lastForcedAt: number | undefined,
  now: number,
): boolean {
  if (current && current !== rejected) return false;
  return lastForcedAt === undefined || now - lastForcedAt >= FORCED_RENEWAL_GAP_MS;
}

/** What renewAfterRejection needs from the session. */
export type RejectionDeps = {
  /** The token the session holds now. */
  current: () => string | undefined;
  hasRefreshToken: () => boolean;
  /** The renewal already under way, if any. */
  inFlight: () => Promise<unknown> | undefined;
  /** Start a renewal. */
  refresh: () => Promise<unknown>;
  now: () => number;
  /** When a 401 last forced a renewal; updated here. */
  forced: { at?: number };
};

/**
 * renewAfterRejection is the token to retry with after the server refused
 * `rejected`.
 *
 * A renewal already under way is waited for, whatever started it: requests
 * that went out together come back together — after a sleep, every request
 * that was in flight answers 401 at once — and the second of them must retry
 * with the token the first one's renewal is fetching, rather than give up on
 * the stale one because FORCED_RENEWAL_GAP_MS has not passed yet.
 */
export async function renewAfterRejection(rejected: string | undefined, deps: RejectionDeps): Promise<string | undefined> {
  const pending = deps.inFlight();
  if (pending) {
    await pending.catch(() => undefined);
    return deps.current();
  }
  if (!deps.hasRefreshToken() || !shouldForceRenewal(rejected, deps.current(), deps.forced.at, deps.now())) {
    return deps.current();
  }
  deps.forced.at = deps.now();
  await deps.refresh().catch(() => undefined);
  return deps.current();
}

/** The session's side of an authorised call (installed by auth/bridge.ts). */
export type TokenSource = {
  /** The token to send now, renewed first when it is inside its expiry margin. */
  fresh: () => Promise<string | undefined>;
  /** A token to try after the server refused `rejected`; may be the same one. */
  renew: (rejected: string | undefined) => Promise<string | undefined>;
};

/**
 * withSessionToken runs `send` with a fresh token and, when the server answers
 * 401, once more with a renewed one — never more than once, and not at all when
 * the renewal produced the token that was just refused.
 *
 * The renewal timer alone is not enough: timers do not run while a machine
 * sleeps and are throttled in a hidden or busy tab, so the token in hand can be
 * dead by the time a request goes out.
 */
export async function withSessionToken<T>(
  source: TokenSource,
  send: (token: string | undefined) => Promise<T>,
  isUnauthorized: (err: unknown) => boolean,
): Promise<T> {
  const token = await source.fresh();
  try {
    return await send(token);
  } catch (err) {
    if (!isUnauthorized(err)) throw err;
    const renewed = await source.renew(token);
    if (!renewed || renewed === token) throw err;
    return send(renewed);
  }
}
