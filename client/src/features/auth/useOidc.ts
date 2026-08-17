import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AuthRequest,
  ResponseType,
  exchangeCodeAsync,
  loadAsync,
  type DiscoveryDocument,
} from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import { KeycloakUnreachableError, SCOPES, forgetDiscovery, keycloak, loadDiscovery, redirectUri } from './config';
import { useSession } from './session';

/**
 * Authorization Code + PKCE against the operator's Keycloak.
 *
 * Three entry points, one flow. Keycloak's `kc_idp_hint` parameter tells the realm
 * to skip its own login form and bounce straight to a configured identity provider,
 * so "Continue with Google" is the *same* authorization request as "Continue with
 * email" plus one query parameter. That matters beyond code size: the app never
 * talks to Google or X directly, never holds their client secrets, and the operator
 * can add or remove a provider in the realm without shipping a new build.
 *
 * Password and TOTP are likewise not this app's business. The hosted Keycloak page
 * runs the browser flow — password, then the OTP step the realm's `totp` policy
 * requires — and hands back an authorization code. There is no credential input in
 * this client, which is the point: a self-hosted product should not be the thing
 * that learns your password.
 */

// On web, Keycloak redirects into a popup; this closes it and hands the URL back to
// the opener. It is a documented no-op on native, so it needs no platform guard.
WebBrowser.maybeCompleteAuthSession();

export type OidcProvider = 'email' | 'google' | 'twitter';

export type OidcErrorKind =
  /** The discovery document could not be fetched — usually a stopped container. */
  | 'unreachable'
  /** Keycloak answered the authorization request with an error (bad client, denied consent). */
  | 'authorization'
  /** The code came back but could not be traded for tokens. */
  | 'exchange';

export type OidcError = {
  kind: OidcErrorKind;
  message: string;
};

export type Oidc = {
  /** The issuer this build will talk to, so a misconfiguration is visible in the UI. */
  issuer: string;
  /** The exact URL fetched for discovery; named in the unreachable error. */
  discoveryUrl: string;
  /** The redirect this app registered — the other half of a redirect-mismatch bug. */
  redirectUri: string;
  /** True while the discovery document is in flight. */
  discovering: boolean;
  /** True once the realm's endpoints are known and sign-in can start. */
  ready: boolean;
  /** The provider whose browser prompt or code exchange is running, if any. */
  pending: OidcProvider | null;
  error: OidcError | null;
  signIn: (provider: OidcProvider) => Promise<void>;
  /** Re-fetch discovery after a failure. */
  retry: () => void;
};

/** Keycloak jumps straight to a provider when told which one; no hint means its own login page. */
function hintFor(provider: OidcProvider): Record<string, string> | undefined {
  return provider === 'email' ? undefined : { kc_idp_hint: provider };
}

function buildRequest(provider: OidcProvider, discovery: DiscoveryDocument): Promise<AuthRequest> {
  return loadAsync(
    {
      clientId: keycloak.clientId,
      redirectUri: redirectUri(),
      responseType: ResponseType.Code,
      scopes: [...SCOPES],
      // The realm pins `pkce.code.challenge.method = S256`; expo-auth-session
      // defaults to the same, and refuses `plain` outright.
      usePKCE: true,
      extraParams: hintFor(provider),
    },
    discovery,
  );
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function useOidc(): Oidc {
  const [discovery, setDiscovery] = useState<DiscoveryDocument | null>(null);
  const [discovering, setDiscovering] = useState(true);
  const [pending, setPending] = useState<OidcProvider | null>(null);
  const [error, setError] = useState<OidcError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Authorization requests are built ahead of the tap, not during it.
   *
   * Generating a PKCE verifier is async, and mobile browsers block `window.open()`
   * that does not follow a user gesture closely enough. Preloading means the press
   * handler reaches `promptAsync` with the URL already built, so the popup opens in
   * the same tick as the click.
   */
  const requests = useRef<Partial<Record<OidcProvider, AuthRequest>>>({});

  useEffect(() => {
    let cancelled = false;
    setDiscovering(true);
    setError(null);

    loadDiscovery()
      .then((doc) => {
        if (cancelled) return;
        setDiscovery(doc);
        setDiscovering(false);
        // Warm all three; a verifier is cheap and the user picks one unpredictably.
        for (const provider of ['email', 'google', 'twitter'] as const) {
          void buildRequest(provider, doc)
            .then((request) => {
              if (!cancelled) requests.current[provider] = request;
            })
            .catch(() => {
              // Falling back to building it on demand is fine; only the popup
              // timing suffers, and only on the first press.
            });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setDiscovering(false);
        setError({
          kind: 'unreachable',
          message:
            err instanceof KeycloakUnreachableError
              ? err.message
              : messageOf(err, `Could not reach Keycloak at ${keycloak.discoveryUrl}`),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback(() => {
    forgetDiscovery();
    requests.current = {};
    setDiscovery(null);
    setAttempt((n) => n + 1);
  }, []);

  const signIn = useCallback(
    async (provider: OidcProvider) => {
      if (!discovery) {
        setError({ kind: 'unreachable', message: `Could not reach Keycloak at ${keycloak.discoveryUrl}` });
        return;
      }

      setPending(provider);
      setError(null);

      try {
        const request = requests.current[provider] ?? (await buildRequest(provider, discovery));
        const result = await request.promptAsync(discovery);

        // State and verifier are single-use, so the warmed request is spent whatever
        // the outcome. Replace it now rather than on the next press.
        delete requests.current[provider];
        void buildRequest(provider, discovery)
          .then((next) => {
            if (mounted.current) requests.current[provider] = next;
          })
          .catch(() => undefined);

        if (result.type !== 'success') {
          // 'cancel' and 'dismiss' mean the user closed the browser. That is an
          // answer, not a failure, and shouting about it would be wrong.
          if (result.type === 'error') {
            setError({
              kind: 'authorization',
              message: result.error?.description ?? result.error?.message ?? 'Keycloak refused the sign-in request.',
            });
          }
          return;
        }

        const code = result.params.code;
        if (!code) {
          setError({ kind: 'authorization', message: 'Keycloak returned no authorization code.' });
          return;
        }

        const tokens = await exchangeCodeAsync(
          {
            clientId: keycloak.clientId,
            code,
            redirectUri: redirectUri(),
            // The public client proves possession with the verifier instead of a
            // secret; without it Keycloak rejects the exchange.
            extraParams: request.codeVerifier ? { code_verifier: request.codeVerifier } : undefined,
          },
          discovery,
        );

        useSession.getState().signIn({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          expiresAt: (tokens.issuedAt + (tokens.expiresIn ?? 300)) * 1000,
        });
      } catch (err) {
        if (mounted.current) {
          setError({ kind: 'exchange', message: messageOf(err, 'The sign-in could not be completed.') });
        }
      } finally {
        if (mounted.current) setPending(null);
      }
    },
    [discovery],
  );

  return {
    issuer: keycloak.issuer,
    discoveryUrl: keycloak.discoveryUrl,
    redirectUri: redirectUri(),
    discovering,
    ready: discovery !== null,
    pending,
    error,
    signIn,
    retry,
  };
}
