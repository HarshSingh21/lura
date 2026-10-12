import { setSessionTokenProvider } from '@/api/client';

import { ensureFreshAccessToken, getAccessToken, renewRejectedToken } from './session';

/**
 * The one wire between the session and the HTTP client.
 *
 * The client deliberately knows nothing about auth — it asks a provider for a
 * bearer on every request. This installs that provider. Keeping the dependency
 * pointing this way (auth → api, never api → auth) is what stops the import cycle
 * that would otherwise exist, since the session itself refreshes over HTTP. (The
 * client does use auth/refresh.ts's retry rule, which imports nothing.)
 *
 * Called once from the root layout, at module scope, so the very first query has
 * a token to send.
 */
export function installSessionBridge(): void {
  setSessionTokenProvider({ current: getAccessToken, fresh: ensureFreshAccessToken, renew: renewRejectedToken });
}
