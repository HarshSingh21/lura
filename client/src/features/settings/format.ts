/**
 * formatCoolOff writes the server's cool-off for the About card. Rounding
 * seconds to whole minutes printed a 15 s cool-off as "0 min", which reads as
 * "no cool-off at all".
 *
 * Dependency-free so `node --test` runs it (format.test.mts).
 */
export function formatCoolOff(seconds: number | undefined): string {
  const s = Math.max(0, Math.round(seconds ?? 0));
  if (s === 0) return 'none';
  if (s < 60) return `${s} s per place/trigger`;
  if (s % 60 === 0 || s >= 600) return `${Math.round(s / 60)} min per place/trigger`;
  return `${Math.floor(s / 60)} min ${s % 60} s per place/trigger`;
}
