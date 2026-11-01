/** Friendly distance label for the student directory; never "~0 m away". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 50) return 'Right here (<50 m away)';
  // Round first, then pick the unit, so 995-999 m reads "~1.0 km" and not "~1000 m".
  const rounded = Math.round(meters / 10) * 10;
  if (rounded < 1000) return `~${rounded} m away`;
  return `~${(meters / 1000).toFixed(1)} km away`;
}
