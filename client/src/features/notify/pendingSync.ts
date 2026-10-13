/**
 * The coalescing rule behind "read the pending reminders" (hooks/useReminders.ts).
 *
 * The list is asked for from several places at once — the viewer becoming known,
 * every socket (re)connect — so calls are folded together: one request at a
 * time, and a call made while one is in flight runs once more after it, so the
 * last answer is never older than the last request for one.
 *
 * Every round first asks `allowed()`. A round queued just before signing out
 * would otherwise go out after it with no session behind it — the client falls
 * back to the development token, which a signed-in deployment answers with 401
 * — and an answer that lands after signing out is dropped rather than painted
 * as cards for nobody.
 *
 * Kept free of imports so it is tested with plain `node --test`
 * (pendingSync.test.mts).
 */

export type PendingSyncDeps<T> = {
  /** Whether a request may go out now (signed in). Checked before each round and before applying its answer. */
  allowed: () => boolean;
  /** Performs one read. */
  fetch: () => Promise<T>;
  /** Applies an answer read at `requestedAt`. */
  apply: (answer: T, requestedAt: number) => void;
  /** Whether a failure is worth reading again for when another call is queued (an HTTP answer); others stop the loop. */
  retryable: (err: unknown) => boolean;
  now?: () => number;
};

/** createPendingSync returns the coalesced sync function. */
export function createPendingSync<T>(deps: PendingSyncDeps<T>): () => Promise<void> {
  const now = deps.now ?? Date.now;
  let syncing: Promise<void> | null = null;
  let again = false;

  return function sync(): Promise<void> {
    if (syncing) {
      again = true;
      return syncing;
    }
    if (!deps.allowed()) return Promise.resolve();
    syncing = (async () => {
      do {
        again = false;
        if (!deps.allowed()) break;
        const requestedAt = now();
        try {
          const answer = await deps.fetch();
          if (deps.allowed()) deps.apply(answer, requestedAt);
        } catch (err) {
          if (!deps.retryable(err)) break;
        }
      } while (again);
    })().finally(() => {
      syncing = null;
      again = false;
    });
    return syncing;
  };
}
