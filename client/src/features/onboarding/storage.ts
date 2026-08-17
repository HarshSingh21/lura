import { Platform } from 'react-native';

/**
 * "Has this person been shown the introduction yet?" — persisted.
 *
 * The flag is deliberately tiny and deliberately not secret: it decides whether a
 * five-screen explainer appears, nothing else. Three consequences shape this file:
 *
 *   - The async API is kept even though `localStorage` is not async. The store
 *     behind it is expected to become a real keychain-backed one, and every
 *     keychain API is asynchronous; a synchronous-only signature would have to be
 *     broken later.
 *   - A *synchronous* snapshot exists alongside it, because the router gate has to
 *     decide where to send someone during render. Awaiting there would mean a
 *     splash frame on every navigation, so the value is cached in memory and the
 *     cache is the thing reads and writes both go through.
 *   - Nothing throws. A browser with storage disabled (private mode, a locked-down
 *     policy) should still be able to finish the introduction — the worst outcome
 *     of a failed write is seeing it again, which is not worth an error screen.
 *
 * Native has no persistent backend yet, so the cache is all there is: correct for
 * the lifetime of the process, and re-shown after a cold start.
 */

const KEY = 'lura.onboarding.seen.v1';

/**
 * webStorage returns `localStorage` only where it genuinely exists. `Platform.OS`
 * is checked first so the native bundle never touches a DOM global at all.
 */
function webStorage(): Storage | null {
  if (Platform.OS !== 'web') return null;
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    // Reading `localStorage` itself throws when storage is blocked by policy.
    return null;
  }
}

/** read pulls the flag straight from storage, falling back to "not seen". */
function read(): boolean {
  const storage = webStorage();
  if (!storage) return false;
  try {
    return storage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** The synchronous truth. Seeded at import so the first render already knows. */
let cached = read();

type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * subscribeOnboarding registers a callback for changes to the flag.
 *
 * It exists so `useSyncExternalStore` can drive the gate: finishing the
 * introduction has to move the router immediately, and polling for a boolean that
 * changes exactly once per account would be silly.
 */
export function subscribeOnboarding(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** onboardingSeenSnapshot is the synchronous read used during render. */
export function onboardingSeenSnapshot(): boolean {
  return cached;
}

function publish(next: boolean) {
  if (cached === next) return;
  cached = next;
  for (const listener of listeners) listener();
}

/** hasSeenOnboarding reports whether the introduction has already been completed or skipped. */
export async function hasSeenOnboarding(): Promise<boolean> {
  return cached;
}

/** markOnboardingSeen records completion. Calling it twice is harmless. */
export async function markOnboardingSeen(): Promise<void> {
  publish(true);
  const storage = webStorage();
  if (!storage) return;
  try {
    storage.setItem(KEY, '1');
  } catch {
    // Quota or policy: the in-memory flag already covers this session.
  }
}

/**
 * resetOnboarding clears the flag so the introduction runs again. It exists for
 * the "show me that again" affordance in settings, and for manual testing.
 */
export async function resetOnboarding(): Promise<void> {
  publish(false);
  const storage = webStorage();
  if (!storage) return;
  try {
    storage.removeItem(KEY);
  } catch {
    // Nothing to undo if the write never landed.
  }
}
