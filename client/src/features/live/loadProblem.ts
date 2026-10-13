/**
 * What the Live map says when the workspace cannot be loaded.
 *
 * Only when there is nothing to show: a background refetch that fails while
 * the map, the people and the reminders are all on screen (a request that was
 * in flight when the laptop slept, answered 401 on waking) must not cover a
 * working map with "Cannot reach the server" — the next refetch or reconnect
 * puts it right, and the live status pill already says when it is not live.
 *
 * The wording follows the failure rather than always blaming the network: a
 * refused session is not an unreachable server, and the server's own text
 * ("oidc: token expired at …") is not for people.
 */

export type LoadProblem = {
  title: string;
  body: string;
  action: 'settings' | 'sign-in';
};

type MaybeApiError = { status?: unknown; message?: unknown };

export function loadProblem(error: unknown, hasData: boolean): LoadProblem | null {
  if (!error || hasData) return null;
  const status = typeof (error as MaybeApiError).status === 'number' ? ((error as MaybeApiError).status as number) : undefined;
  if (status === 401 || status === 403) {
    return {
      title: 'Your session was not accepted',
      body: 'Sign in again to load your workspace.',
      action: 'sign-in',
    };
  }
  if (status !== undefined && status >= 500) {
    return {
      title: 'The Lura server had a problem',
      body: `It answered ${status}. Try again in a moment, or check the server's logs.`,
      action: 'settings',
    };
  }
  const message = typeof (error as MaybeApiError).message === 'string' ? ((error as MaybeApiError).message as string) : '';
  return {
    title: 'Cannot reach the Lura server',
    body: message ? `${message}. Check the server address in Settings.` : 'Check the server address in Settings.',
    action: 'settings',
  };
}
