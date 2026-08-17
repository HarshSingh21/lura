import Svg, { Path } from 'react-native-svg';

import { color } from '@/theme/tokens';

/**
 * The two social marks, drawn rather than imported.
 *
 * `components/ui/Icon.tsx` is the product's own single-stroke icon set and these
 * do not belong in it: both are third-party trademarks whose colour and geometry
 * are fixed by their owners' brand rules, so they cannot take a `stroke` prop or
 * be recoloured to match a button. Keeping them here also keeps the airgap promise
 * intact — no remote logo fetch, no CDN sprite.
 */

/** GoogleGlyph is Google's four-colour "G", required to appear on a light surface. */
export function GoogleGlyph({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <Path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <Path
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.07H2.18A10.99 10.99 0 0 0 1 12c0 1.78.43 3.46 1.18 4.93l3.66-2.83z"
        fill="#FBBC05"
      />
      <Path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.83C6.71 7.31 9.14 5.38 12 5.38z"
        fill="#EA4335"
      />
    </Svg>
  );
}

/** XGlyph is the X (formerly Twitter) mark; the realm still calls the provider `twitter`. */
export function XGlyph({ size = 15 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M18.9 1.153h3.682l-8.042 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932zM17.61 20.644h2.04L6.486 3.24H4.298z"
        fill={color.textStrong}
      />
    </Svg>
  );
}
