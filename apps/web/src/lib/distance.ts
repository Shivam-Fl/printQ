/** Friendly distance label for the student directory; never "~0 m away". */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 50) return 'Right here (<50 m away)';
  if (meters < 1000) return `~${Math.round(meters / 10) * 10} m away`;
  return `~${(meters / 1000).toFixed(1)} km away`;
}
