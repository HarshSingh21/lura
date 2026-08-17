/**
 * Metro bundles CSS for the web target, but TypeScript has no notion of a
 * side-effect CSS import. Declaring the module here keeps `tsc --noEmit` honest
 * without disabling checks on the file that needs the stylesheet.
 */
declare module '*.css';
