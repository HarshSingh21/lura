import { useSession, type AuthStatus } from './session';
import type { Profile } from './jwt';

/**
 * The auth gate, as a hook rather than a component.
 *
 * Deliberately it does *not* navigate. Route wiring belongs to whichever layout
 * owns the tree — a hook that calls `router.replace` from inside a layout render
 * fights whatever else that layout is doing, and makes the redirect invisible to
 * the person reading the routes. This returns the three facts a layout needs and
 * lets it render `<Redirect />` itself.
 *
 * The `ready` flag is the one that matters: persisted tokens are read
 * asynchronously, so treating "not read yet" as "signed out" flashes the login
 * screen on every cold start.
 */

export type AuthGate = {
  status: AuthStatus;
  /** False only while the persisted session is still being read. Show a splash. */
  ready: boolean;
  isSignedIn: boolean;
  profile?: Profile;
};

/** The canonical path of the sign-in screen, so callers do not hard-code it. */
export const LOGIN_ROUTE = '/login';

/**
 * useRequireAuth reports whether the current session may see the app.
 *
 * @example
 * ```tsx
 * const { ready, isSignedIn } = useRequireAuth();
 * if (!ready) return <Splash />;
 * if (!isSignedIn) return <Redirect href={LOGIN_ROUTE} />;
 * ```
 */
export function useRequireAuth(): AuthGate {
  const status = useSession((s) => s.status);
  const profile = useSession((s) => s.profile);

  return {
    status,
    ready: status !== 'unknown',
    isSignedIn: status === 'signed-in',
    profile,
  };
}
