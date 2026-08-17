import { Platform } from 'react-native';
import { TokenError, refreshAsync, revokeAsync, TokenTypeHint, type TokenResponse } from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

import { keycloak, loadDiscovery } from './config';
import { decodeIdToken, type Profile } from './jwt';

/**
 * The signed-in session (HLD §14: Zustand for local state).
 *
 * Two things drive the shape of this store:
 *
 *   - **It outlives the process.** Tokens go to the platform keystore on native and
 *     to `localStorage` on web — same guard as `state/store.ts` uses for the
 *     connection settings — and are restored before the first screen paints, so a
 *     cold start does not bounce a signed-in user back to the login page.
 *   - **It refreshes ahead of expiry.** A location app sits open for hours; the
 *     realm issues 15-minute access tokens. Waiting for a 401 would mean the map
 *     silently stops moving mid-drive, so a timer renews the token a minute before
 *     it lapses and the UI never sees the seam.
 *
 * The interactive part of sign-in (opening Keycloak) lives in `useOidc.ts`. This
 * store only ever *adopts* the result, which is why `signIn` takes tokens rather
 * than credentials — it is equally the path used by the silent refresh.
 */

export type AuthStatus = 'unknown' | 'signed-out' | 'signed-in';

export type SessionTokens = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds at which the access token stops being accepted. */
  expiresAt: number;
};

export type SessionState = {
  status: AuthStatus;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: number;
  profile?: Profile;
  /** Why the last sign-in or silent refresh failed. Cleared by the next success. */
  error?: string;

  /** Adopt the tokens from a completed code exchange or refresh. */
  signIn: (tokens: SessionTokens) => void;
  /** Drop the session locally and revoke the refresh token at Keycloak (best effort). */
  signOut: () => void;
  /** Renew the access token now. Resolves `true` when the session is usable afterwards. */
  refresh: () => Promise<boolean>;
  /** Reload persisted tokens. Called once at boot; safe to call again. */
  restore: () => Promise<void>;
};

/**
 * Tokens are stored under one key each rather than as a single JSON blob:
 * SecureStore on Android warns (and on some OEM builds fails) past 2048 bytes per
 * entry, and a Keycloak access + refresh + ID token together clear that easily.
 */
const KEYS = {
  access: 'lura.session.access',
  refresh: 'lura.session.refresh',
  id: 'lura.session.id',
  expiresAt: 'lura.session.expires',
} as const;

/** Renew this long before expiry, so a slow network still beats the deadline. */
const REFRESH_MARGIN_MS = 60_000;
/** Floor on the renewal timer, so a short-lived token cannot spin the refresh loop. */
const MIN_REFRESH_DELAY_MS = 5_000;
/** A refresh that failed on the network (not on the token) is retried this often. */
const RETRY_DELAY_MS = 30_000;

/* ------------------------------------------------------------------ storage */

function webStorage(): Storage | null {
  if (Platform.OS !== 'web' || typeof localStorage === 'undefined') return null;
  return localStorage;
}

async function readItem(key: string): Promise<string | null> {
  const storage = webStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }
  if (Platform.OS === 'web') return null; // SSR / prerender: no storage to read
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    // A keystore that refuses to unlock is a signed-out session, not a crash.
    return null;
  }
}

async function writeItem(key: string, value: string | undefined): Promise<void> {
  const storage = webStorage();
  if (storage) {
    try {
      if (value === undefined) storage.removeItem(key);
      else storage.setItem(key, value);
    } catch {
      // A private-mode browser refusing storage is not worth failing over.
    }
    return;
  }
  if (Platform.OS === 'web') return;
  try {
    if (value === undefined) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, value);
  } catch {
    // Losing persistence costs a re-login, not the current session.
  }
}

/** persist mirrors the session to disk. It is a side effect of signing in, never a gate on it. */
function persist(tokens: SessionTokens | null): void {
  void Promise.all([
    writeItem(KEYS.access, tokens?.accessToken),
    writeItem(KEYS.refresh, tokens?.refreshToken),
    writeItem(KEYS.id, tokens?.idToken),
    writeItem(KEYS.expiresAt, tokens === null ? undefined : String(tokens.expiresAt)),
  ]);
}

/* ------------------------------------------------------------- refresh timer */

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let inFlightRefresh: Promise<boolean> | undefined;

function clearRefreshTimer() {
  if (refreshTimer !== undefined) {
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  }
}

function scheduleRefresh(delayMs: number) {
  clearRefreshTimer();
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void useSession.getState().refresh();
  }, delayMs);
}

/** toTokens folds a token response onto the session, keeping what the server omitted. */
function toTokens(response: TokenResponse, previous: SessionState): SessionTokens {
  return {
    accessToken: response.accessToken,
    // Keycloak rotates refresh tokens, but a provider that withholds one means
    // "keep using the one you have" — dropping it would end the session early.
    refreshToken: response.refreshToken ?? previous.refreshToken,
    idToken: response.idToken ?? previous.idToken,
    // `issuedAt` is the client's own clock at receipt, which is the right base:
    // it makes the deadline immune to a skewed server clock.
    expiresAt: (response.issuedAt + (response.expiresIn ?? 300)) * 1000,
  };
}

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Sign-in failed for an unknown reason.';
}

/* -------------------------------------------------------------------- store */

export const useSession = create<SessionState>((set, get) => ({
  // 'unknown' rather than 'signed-out': the persisted tokens are read
  // asynchronously, and a gate that treats "not read yet" as "not signed in"
  // flashes the login screen on every cold start.
  status: 'unknown',

  signIn: (tokens) => {
    set({
      status: 'signed-in',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: tokens.expiresAt,
      profile: decodeIdToken(tokens.idToken) ?? get().profile,
      error: undefined,
    });
    persist(tokens);
    scheduleRefresh(Math.max(MIN_REFRESH_DELAY_MS, tokens.expiresAt - Date.now() - REFRESH_MARGIN_MS));
  },

  signOut: () => {
    const { refreshToken } = get();
    clearRefreshTimer();
    set({
      status: 'signed-out',
      accessToken: undefined,
      refreshToken: undefined,
      idToken: undefined,
      expiresAt: undefined,
      profile: undefined,
      error: undefined,
    });
    persist(null);

    // Best effort: kill the refresh token server-side too, so a copy lifted off a
    // stolen device is already dead. Failure here is invisible on purpose — the
    // local session is gone either way, which is what the user asked for.
    if (refreshToken) {
      void loadDiscovery()
        .then((discovery) =>
          discovery.revocationEndpoint
            ? revokeAsync(
                { clientId: keycloak.clientId, token: refreshToken, tokenTypeHint: TokenTypeHint.RefreshToken },
                discovery,
              )
            : false,
        )
        .catch(() => false);
    }
  },

  refresh: () => {
    if (inFlightRefresh) return inFlightRefresh;

    const { refreshToken } = get();
    if (!refreshToken) return Promise.resolve(false);

    inFlightRefresh = (async () => {
      try {
        const discovery = await loadDiscovery();
        const response = await refreshAsync({ clientId: keycloak.clientId, refreshToken }, discovery);
        get().signIn(toTokens(response, get()));
        return true;
      } catch (err) {
        // A token Keycloak refuses is terminal — the session is over and the only
        // honest move is to send the user back to sign-in. A network failure is
        // not: the container may be restarting, so hold the session and retry.
        if (err instanceof TokenError) {
          clearRefreshTimer();
          set({
            status: 'signed-out',
            accessToken: undefined,
            refreshToken: undefined,
            idToken: undefined,
            expiresAt: undefined,
            profile: undefined,
            error: 'Your session expired. Sign in again to continue.',
          });
          persist(null);
        } else {
          set({ error: messageOf(err) });
          scheduleRefresh(RETRY_DELAY_MS);
        }
        return false;
      } finally {
        inFlightRefresh = undefined;
      }
    })();

    return inFlightRefresh;
  },

  restore: async () => {
    const [accessToken, refreshToken, idToken, rawExpiry] = await Promise.all([
      readItem(KEYS.access),
      readItem(KEYS.refresh),
      readItem(KEYS.id),
      readItem(KEYS.expiresAt),
    ]);

    if (!accessToken && !refreshToken) {
      set({ status: 'signed-out' });
      return;
    }

    const expiresAt = Number(rawExpiry);
    const tokens: SessionTokens = {
      accessToken: accessToken ?? '',
      refreshToken: refreshToken ?? undefined,
      idToken: idToken ?? undefined,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    };

    const stale = !tokens.accessToken || tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if (stale) {
      if (!tokens.refreshToken) {
        set({ status: 'signed-out' });
        persist(null);
        return;
      }
      // Adopt the refresh token first so `refresh()` can find it, but stay at
      // 'unknown' until it resolves — claiming 'signed-in' with a dead access
      // token would let the first request fire and fail.
      set({ refreshToken: tokens.refreshToken, idToken: tokens.idToken, profile: decodeIdToken(tokens.idToken) });
      const ok = await get().refresh();
      if (!ok && get().status !== 'signed-in') set({ status: 'signed-out' });
      return;
    }

    get().signIn(tokens);
  },
}));

/* ------------------------------------------------------------- boot + getters */

let restoreStarted = false;

/**
 * restoreSession reads the persisted tokens. It runs once at import time so the
 * session is settling while the fonts load; calling it again is a no-op.
 */
export function restoreSession(): void {
  if (restoreStarted) return;
  restoreStarted = true;
  void useSession.getState().restore();
}

restoreSession();

/**
 * getAccessToken is the plain getter for non-React callers (the API client, the
 * WebSocket URL builder). It never blocks and never triggers a refresh: the timer
 * above is what keeps the value current.
 */
export function getAccessToken(): string | undefined {
  return useSession.getState().accessToken;
}

/** getSessionStatus mirrors `getAccessToken` for code that needs to branch on auth. */
export function getSessionStatus(): AuthStatus {
  return useSession.getState().status;
}

/**
 * ensureFreshAccessToken is the awaiting variant: it renews first if the token is
 * inside its expiry margin. Use it where a stale token would cost a visible
 * failure — a download URL, or a WebSocket handshake that cannot retry a 401.
 */
export async function ensureFreshAccessToken(): Promise<string | undefined> {
  const { accessToken, expiresAt, refreshToken } = useSession.getState();
  const expiring = expiresAt === undefined || expiresAt - Date.now() < REFRESH_MARGIN_MS;
  if (accessToken && !expiring) return accessToken;
  if (!refreshToken) return accessToken;
  await useSession.getState().refresh();
  return useSession.getState().accessToken;
}

/** Selectors, so components subscribe to the narrowest slice they need. */
export const selectStatus = (s: SessionState) => s.status;
export const selectProfile = (s: SessionState) => s.profile;
export const selectAccessToken = (s: SessionState) => s.accessToken;
