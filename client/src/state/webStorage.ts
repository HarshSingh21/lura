/**
 * localStorageOrNull is the page's localStorage, or null where there is none.
 *
 * `typeof localStorage` is not a safe guard on its own: a browser that blocks
 * site data (cookies off, a sandboxed frame, some private modes) answers the
 * property read itself with a SecurityError, and `typeof` does not swallow
 * that. A guard outside a try/catch therefore crashes whatever ran it — at
 * module load, the whole app. Every storage read goes through here instead.
 *
 * Dependency-free so `node --test` runs it (storage.clientgeo.test.mts).
 */
export function localStorageOrNull(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage ?? null;
  } catch {
    return null;
  }
}
