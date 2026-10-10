import type { Response } from 'express';
import { env } from '../../config/env.js';
import { TtlCache } from '../../lib/ttlCache.js';

// Public discovery lists contain nothing user-scoped, so one short-lived copy
// per instance is safe. Tests default to 0 (no caching) so state changes are
// visible immediately; production default is 15 s.
const ttlSeconds = env.PUBLIC_LIST_CACHE_SECONDS ?? (env.NODE_ENV === 'test' ? 0 : 15);

export const publicShopsCache = new TtlCache<unknown>(ttlSeconds * 1000);
export const publicCampusesCache = new TtlCache<unknown>(ttlSeconds * 1000);

/** Called when admins publish/unpublish/reject a shop so this instance is fresh immediately. */
export function invalidatePublicCaches(): void {
  publicShopsCache.clear();
  publicCampusesCache.clear();
}

/** Browsers/CDN may reuse the list briefly and revalidate in the background. */
export function setPublicListCacheHeaders(res: Response): void {
  if (ttlSeconds > 0) {
    res.set('Cache-Control', `public, max-age=${ttlSeconds}, stale-while-revalidate=60`);
  }
}
