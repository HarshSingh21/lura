import { setSessionTokenProvider } from '@/api/client';

import { ensureFreshAccessToken, getAccessToken } from './session';

/**
 * The one wire between the session and the HTTP client.
 *
 * The client deliberately knows nothing about auth — it asks a provider for a
 * bearer on every request. This installs that provider. Keeping the dependency
 * pointing this way (auth → api, never api → auth) is what stops the import cycle
 * that would otherwise exist, since the session itself refreshes over HTTP.
 *
 * Called once from the root layout, at module scope, so the very first query has
 * a token to send.
 */
export function installSessionBridge(): void {
  setSessionTokenProvider(getAccessToken, ensureFreshAccessToken);
}
