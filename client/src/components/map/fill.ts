import type { ViewStyle } from 'react-native';

/**
 * An absolute-fill style as a plain object.
 *
 * `StyleSheet.absoluteFill` is a registered style ID, which cannot be spread into
 * another style object — and the object form was dropped from React Native's
 * types. Declaring it once here keeps the overlay layers honest and typed.
 */
export const absoluteFill: ViewStyle = {
  position: 'absolute',
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
};
