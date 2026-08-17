import { fetchDiscoveryAsync, makeRedirectUri, type DiscoveryDocument } from 'expo-auth-session';

/**
 * Where sign-in happens.
 *
 * Lura is self-hosted, so the identity provider is the operator's own Keycloak —
 * not a SaaS tenant this app was built against. Everything below therefore reads
 * from `EXPO_PUBLIC_*` at build time and falls back to the values in
 * `deploy/keycloak/lura-realm.json`, so a fresh clone with the local stack up
 * signs in with no configuration at all.
 *
 * The realm ships `lura-app` as a *public* client with `pkce.code.challenge.method
 * = S256`: there is no client secret to leak into a bundle, and Keycloak will
 * reject an authorization code that arrives without its verifier.
 */

/** Env is read through literal `process.env.X` so Expo can inline it at build time. */
const ENV_URL = process.env.EXPO_PUBLIC_KEYCLOAK_URL;
const ENV_REALM = process.env.EXPO_PUBLIC_KEYCLOAK_REALM;
const ENV_CLIENT_ID = process.env.EXPO_PUBLIC_KEYCLOAK_CLIENT_ID;

const baseUrl = (ENV_URL?.trim() || 'http://localhost:8085').replace(/\/$/, '');
const realm = ENV_REALM?.trim() || 'lura';

export const keycloak = {
  /** Origin of the Keycloak server, e.g. `http://localhost:8085`. */
  baseUrl,
  realm,
  clientId: ENV_CLIENT_ID?.trim() || 'lura-app',
  /** The OIDC issuer; `fetchDiscoveryAsync` appends `/.well-known/openid-configuration`. */
  issuer: `${baseUrl}/realms/${realm}`,
  /** Named in the error state so a misconfiguration is visible rather than guessed at. */
  discoveryUrl: `${baseUrl}/realms/${realm}/.well-known/openid-configuration`,
} as const;

/**
 * `offline_access` is deliberately absent: it is an *optional* client scope in
 * Keycloak, so asking for it on a realm that has not assigned it fails the whole
 * authorization with `invalid_scope`. The realm's SSO session already runs for
 * 30 days idle, which the silent refresh in `session.ts` keeps alive.
 */
export const SCOPES = ['openid', 'profile', 'email'] as const;

/**
 * The redirect lands back on `/login` rather than the app root.
 *
 * On web the popup that Keycloak redirects has to load a page that calls
 * `WebBrowser.maybeCompleteAuthSession()`; expo-router evaluates every route
 * module at startup, so landing on the login route guarantees `useOidc` has been
 * imported and that call has run. `lura://login` and `exp://…/--/login` both match
 * the realm's registered redirect URIs (`lura://*`, `exp://*`).
 */
const REDIRECT_PATH = 'login';

let cachedRedirectUri: string | undefined;

/** redirectUri is memoised because on native it inspects the dev-server address. */
export function redirectUri(): string {
  if (cachedRedirectUri === undefined) {
    cachedRedirectUri = makeRedirectUri({ scheme: 'lura', path: REDIRECT_PATH });
  }
  return cachedRedirectUri;
}

/** Thrown when the discovery document cannot be fetched at all — almost always a stopped container. */
export class KeycloakUnreachableError extends Error {
  readonly url: string;

  constructor(url: string, cause: unknown) {
    super(`Could not reach Keycloak at ${url}`);
    this.name = 'KeycloakUnreachableError';
    this.url = url;
    this.cause = cause;
  }
}

let discoveryPromise: Promise<DiscoveryDocument> | undefined;

/**
 * loadDiscovery fetches (once) the realm's endpoints.
 *
 * The promise is cached so the login screen and the background token refresh share
 * one request, and dropped on failure so `retry` actually retries instead of
 * replaying the same rejection forever.
 */
export function loadDiscovery(): Promise<DiscoveryDocument> {
  if (!discoveryPromise) {
    discoveryPromise = fetchDiscoveryAsync(keycloak.issuer).catch((err: unknown) => {
      discoveryPromise = undefined;
      throw new KeycloakUnreachableError(keycloak.discoveryUrl, err);
    });
  }
  return discoveryPromise;
}

/** forgetDiscovery drops the cache so the next load re-fetches (used by the retry button). */
export function forgetDiscovery() {
  discoveryPromise = undefined;
}
