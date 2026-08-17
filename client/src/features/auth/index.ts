/**
 * The auth feature's public surface.
 *
 * Everything the rest of the app is meant to touch is re-exported here, so the
 * internals (the PKCE plumbing, the JWT decoder, the storage keys) can move
 * without a single import elsewhere changing.
 *
 * Importing this module starts the session restore, which is why the API client
 * can call `getAccessToken()` without arranging any bootstrap of its own.
 */

export {
  useSession,
  restoreSession,
  getAccessToken,
  getSessionStatus,
  ensureFreshAccessToken,
  selectStatus,
  selectProfile,
  selectAccessToken,
  type AuthStatus,
  type SessionState,
  type SessionTokens,
} from './session';

export { useRequireAuth, LOGIN_ROUTE, type AuthGate } from './gate';

export { useOidc, type Oidc, type OidcError, type OidcErrorKind, type OidcProvider } from './useOidc';

export { LoginScreen } from './LoginScreen';

export { decodeIdToken, initialsFor, type Profile } from './jwt';

export { keycloak, redirectUri, SCOPES } from './config';

export { installSessionBridge } from './bridge';
