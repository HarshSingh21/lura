import { useWindowDimensions } from 'react-native';

import { layout } from './tokens';

/**
 * The surface capability rule from HLD §14 in one hook.
 *
 * Web is the full control centre (sidebar + map + rail); a phone gets the same
 * data with bottom tabs and a sheet, because 360 dp cannot host three columns.
 * Deciding this from width rather than from platform matters: a tablet, a small
 * browser window and a phone in landscape should all get the layout that fits,
 * not the layout their OS implies.
 */
export type LayoutMode = 'phone' | 'wide' | 'desktop';

export function useLayoutMode(): {
  mode: LayoutMode;
  isPhone: boolean;
  isWide: boolean;
  isDesktop: boolean;
  width: number;
  height: number;
} {
  const { width, height } = useWindowDimensions();
  const mode: LayoutMode =
    width >= layout.desktop ? 'desktop' : width >= layout.wide ? 'wide' : 'phone';
  return {
    mode,
    isPhone: mode === 'phone',
    isWide: mode !== 'phone',
    isDesktop: mode === 'desktop',
    width,
    height,
  };
}
