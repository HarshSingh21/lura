/**
 * React Native CLI / Expo autolinking configuration.
 *
 * Mappls' native SDK is linked only into builds made with LURA_MAPPLS=1. Its
 * Android build fails outright without the licence files, and the default
 * build must stay the open, nothing-phones-home one — so a plain
 * `npx expo run:android` behaves exactly as it did before Mappls existed.
 * See docs/mappls.md.
 */
const withMappls = process.env.LURA_MAPPLS === '1';

module.exports = {
  dependencies: withMappls
    ? {}
    : { 'mappls-map-react-native': { platforms: { android: null, ios: null } } },
};
