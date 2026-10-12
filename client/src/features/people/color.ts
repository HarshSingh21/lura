/**
 * personColor gives each person a stable colour, derived from their user id.
 *
 * The same person should be the same colour in a toast, in the notification
 * centre and on the map, on every device, without anyone storing a preference —
 * so it is a hash of the id into a fixed palette. The palette avoids the brand
 * green (the viewer's own devices own it) and the danger red.
 *
 * It must agree with the map's `colorForUser` (features/live/motion.ts): same
 * palette, same order, same hash, so a person's toast and marker match. The
 * unit tests hold the two together.
 */
export const PERSON_COLORS = [
  '#7c5cff', // violet
  '#e0568f', // rose
  '#2f80ed', // blue
  '#e5603b', // vermilion
  '#0aa2c0', // teal
  '#b5651d', // copper
  '#c03fd6', // orchid
  '#d29a00', // mustard
] as const;

export function personColor(userId: string | undefined): string {
  if (!userId) return PERSON_COLORS[0];
  // FNV-1a: tiny, stable across platforms, and spreads short ids well.
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i += 1) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return PERSON_COLORS[(h >>> 0) % PERSON_COLORS.length] ?? PERSON_COLORS[0];
}
