/**
 * Shops operate on the Indian calendar. Timestamps stay in UTC in the database;
 * "today" and per-day buckets are cut at IST (UTC+05:30, no DST) midnight.
 */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

/** UTC instant of 00:00 IST on the IST calendar day containing `at`. */
export function startOfIstDay(at: number | Date = Date.now()): Date {
  const ms = typeof at === 'number' ? at : at.getTime();
  const local = ms + IST_OFFSET_MS;
  return new Date(local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - IST_OFFSET_MS);
}

/** `YYYY-MM-DD` of the IST calendar day containing `at`. */
export function istDayKey(at: number | Date): string {
  const ms = typeof at === 'number' ? at : at.getTime();
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The last `n` IST day keys, oldest first, ending with today (IST). */
export function lastIstDayKeys(n: number, now: number | Date = Date.now()): string[] {
  const todayStart = startOfIstDay(now).getTime();
  return [...Array(n)].map((_, i) => istDayKey(todayStart + (i - (n - 1)) * DAY_MS));
}
