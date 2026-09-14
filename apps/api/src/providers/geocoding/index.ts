import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';

export interface GeocodingResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

interface NominatimResult {
  place_id?: number;
  display_name?: string;
  lat?: string;
  lon?: string;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const cache = new Map<string, { expiresAt: number; results: GeocodingResult[] }>();
let providerQueue: Promise<void> = Promise.resolve();
let nextProviderRequestAt = 0;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * The public Nominatim service permits at most one request per second. All
 * uncached requests are serialized in this process; PrintQs currently runs a
 * single Render web instance. The frontend never talks to the provider
 * directly, so this implementation can be replaced without an app update.
 */
async function providerRequest(url: URL): Promise<Response> {
  let resolveTurn!: () => void;
  const previous = providerQueue;
  providerQueue = new Promise<void>((resolve) => { resolveTurn = resolve; });
  await previous;

  try {
    const delay = Math.max(0, nextProviderRequestAt - Date.now());
    if (delay) await wait(delay);
    nextProviderRequestAt = Date.now() + 1_050;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'en-IN,en;q=0.9',
        Referer: 'https://printqs.com/',
        'User-Agent': 'PrintQs/0.1 (https://printqs.com; shop location setup)',
      },
      signal: AbortSignal.timeout(10_000),
    });
    return response;
  } finally {
    resolveTurn();
  }
}

export async function searchIndianLocations(query: string): Promise<GeocodingResult[]> {
  const normalized = query.trim().replace(/\s+/g, ' ').slice(0, 180);
  const cacheKey = createHash('sha256').update(normalized.toLocaleLowerCase('en-IN')).digest('hex');
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.results;

  const url = new URL('/search', env.GEOCODING_BASE_URL);
  url.searchParams.set('q', normalized);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('countrycodes', 'in');
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('limit', '5');

  const response = await providerRequest(url);
  if (!response.ok) throw new Error(`Geocoding provider returned ${response.status}`);
  const body = await response.json() as NominatimResult[];
  const results = body.flatMap((item): GeocodingResult[] => {
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (!item.display_name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];
    return [{
      id: String(item.place_id ?? `${latitude},${longitude}`),
      label: item.display_name.slice(0, 300),
      latitude,
      longitude,
    }];
  });

  if (cache.size >= 500) cache.delete(cache.keys().next().value ?? '');
  cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, results });
  return results;
}
