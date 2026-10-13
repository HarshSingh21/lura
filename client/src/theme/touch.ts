import { Platform, useWindowDimensions } from 'react-native';

import { layout } from './tokens';
import { wantsTouchTargets } from './touchTargets';

export { legibleSize, MIN_TOUCH_TYPE, TOUCH_TARGET, touchTarget, wantsTouchTargets } from './touchTargets';

function coarse(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

/** useTouchTargets is wantsTouchTargets for this window, re-evaluated as it resizes. */
export function useTouchTargets(): boolean {
  const { width } = useWindowDimensions();
  return wantsTouchTargets({ native: Platform.OS !== 'web', width, coarsePointer: coarse(), wide: layout.wide });
}
