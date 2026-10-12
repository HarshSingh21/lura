/**
 * personColor gives each person a stable colour, derived from their user id.
 *
 * The same person should be the same colour in a toast, in the notification
 * centre and on the map, on every device, without anyone storing a preference —
 * so it is a hash of the id into a fixed palette. The palette avoids the brand
 * green (the viewer's own devices own it) and the danger red.
 */
export const PERSON_COLORS = [
  '#df8f48', // amber
  '#5b7fe0', // blue
  '#b05bd6', // violet
  '#d6577f', // rose
  '#2f9fb3', // teal
  '#8a9a3a', // olive
  '#c9a227', // mustard
  '#6a6fd1', // indigo
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
