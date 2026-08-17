import { useSyncExternalStore } from 'react';

import { onboardingSeenSnapshot, subscribeOnboarding } from './storage';

/**
 * useOnboarded reports whether the introduction has been seen.
 *
 * `useSyncExternalStore` rather than `useState` + `useEffect`: the value is read
 * during the render that decides where to navigate, and the tearing guarantees
 * matter here — a gate that reads a stale `false` one frame after the person
 * finishes the tour bounces them straight back into it.
 *
 * The server snapshot is `true` so static rendering never emits the introduction
 * into the HTML for someone who has already finished it.
 */
export function useOnboarded(): boolean {
  return useSyncExternalStore(subscribeOnboarding, onboardingSeenSnapshot, () => true);
}
