import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';

export interface GeocodingResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

export interface SearchBias {
  latitude: number;
  longitude: number;
}

interface NominatimItem {
  place_id?: number;
  osm_type?: string;
  osm_id?: number;
  display_name?: string;
  lat?: string;
  lon?: string;
}

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown> & { osm_id?: number; osm_type?: string };
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const CACHE_MAX = 500;
const RESULT_LIMIT = 10;
/** Bias box half-size in degrees (~55 km): prefer, but never restrict to, results near the caller. */
const BIAS_DELTA = 0.5;

const cache = new Map<string, { expiresAt: number; value: unknown }>();

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  if (hit) cache.delete(key);
  return undefined;
}

function cacheSet(key: string, value: unknown): void {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value ?? '');
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

const hashKey = (...parts: string[]) =>
  createHash('sha256').update(parts.join('|').toLocaleLowerCase('en')).digest('hex');

/**
 * Both free OSM services ask for at most about one request per second. Each
 * provider gets its own serialized queue in this process. The frontend never
 * talks to a provider directly, so providers can be swapped without an app update.
 */
function makeQueue(minGapMs: number) {
  let queue: Promise<void> = Promise.resolve();
  let nextAt = 0;
  return async function request(url: URL): Promise<Response> {
    let release!: () => void;
    const previous = queue;
    queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const delay = Math.max(0, nextAt - Date.now());
      if (delay) await wait(delay);
      nextAt = Date.now() + minGapMs;
      return await fetch(url, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'en;q=0.9',
          Referer: 'https://printqs.com/',
          'User-Agent': 'PrintQs/0.1 (https://printqs.com; shop location setup)',
        },
        signal: AbortSignal.timeout(8_000),
      });
    } finally {
      release();
    }
  };
}

const primaryRequest = makeQueue(1_050);
const fallbackRequest = makeQueue(1_050);

function validCoords(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

function fromNominatim(body: unknown): GeocodingResult[] {
  if (!Array.isArray(body)) return [];
  return (body as NominatimItem[]).flatMap((item): GeocodingResult[] => {
    const latitude = Number(item.lat);
    const longitude = Number(item.lon);
    if (!item.display_name || !validCoords(latitude, longitude)) return [];
    return [{
      id: String(item.place_id ?? `${latitude},${longitude}`),
      label: item.display_name.slice(0, 300),
      latitude,
      longitude,
    }];
  });
}

/** Photon returns address parts, not a display name; build one like "Name, street no, city, state, country". */
function photonLabel(p: Record<string, unknown>): string {
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string) : '');
  const street = [str('street'), str('housenumber')].filter(Boolean).join(' ');
  const parts = [str('name'), street, str('district') || str('suburb'), str('city') || str('town') || str('village') || str('county'),
    str('state'), str('postcode'), str('country')].filter(Boolean);
  return [...new Set(parts)].join(', ').slice(0, 300);
}

function fromPhoton(body: unknown): GeocodingResult[] {
  const features = (body as { features?: PhotonFeature[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  return features.flatMap((f): GeocodingResult[] => {
    const [longitude, latitude] = f.geometry?.coordinates ?? [];
    const props = f.properties ?? {};
    const label = photonLabel(props);
    if (!label || typeof latitude !== 'number' || typeof longitude !== 'number' || !validCoords(latitude, longitude)) return [];
    const id = props.osm_id ? `${props.osm_type ?? 'x'}${props.osm_id}` : `${latitude},${longitude}`;
    return [{ id, label, latitude, longitude }];
  });
}

async function getJson(request: (url: URL) => Promise<Response>, url: URL): Promise<unknown> {
  const response = await request(url);
  if (!response.ok) throw new Error(`Geocoding provider returned ${response.status}`);
  return response.json();
}

/**
 * Worldwide address / shop / POI search. Primary: Nominatim. Fallback: Photon
 * (both OSM-based, free, no key) when the primary errors or finds nothing.
 * Never throws: any provider failure yields an empty list so setup is never blocked.
 */
export async function searchLocations(query: string, bias?: SearchBias): Promise<GeocodingResult[]> {
  const normalized = query.trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!normalized) return [];
  // Round the bias so nearby callers share cache entries.
  const b = bias && validCoords(bias.latitude, bias.longitude)
    ? { latitude: Math.round(bias.latitude * 10) / 10, longitude: Math.round(bias.longitude * 10) / 10 }
    : undefined;
  const cacheKey = hashKey('s', normalized, b ? `${b.latitude},${b.longitude}` : '');
  const cached = cacheGet<GeocodingResult[]>(cacheKey);
  if (cached) return cached;

  let results: GeocodingResult[] = [];
  let failed = false;
  try {
    const url = new URL('/search', env.GEOCODING_BASE_URL);
    url.searchParams.set('q', normalized);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('addressdetails', '0');
    url.searchParams.set('limit', String(RESULT_LIMIT));
    if (b) {
      // viewbox is left,top,right,bottom; bounded stays 0 so it only biases ranking.
      url.searchParams.set('viewbox', [b.longitude - BIAS_DELTA, b.latitude + BIAS_DELTA, b.longitude + BIAS_DELTA, b.latitude - BIAS_DELTA].join(','));
      url.searchParams.set('bounded', '0');
    }
    results = fromNominatim(await getJson(primaryRequest, url));
  } catch {
    failed = true;
  }

  if (results.length === 0) {
    try {
      const url = new URL('/api', env.GEOCODING_FALLBACK_BASE_URL);
      url.searchParams.set('q', normalized);
      url.searchParams.set('limit', String(RESULT_LIMIT));
      if (b) {
        url.searchParams.set('lat', String(b.latitude));
        url.searchParams.set('lon', String(b.longitude));
      }
      results = fromPhoton(await getJson(fallbackRequest, url));
    } catch {
      failed = true;
    }
  }

  // Do not cache outage-driven empties; a genuine "nothing found" is cached.
  if (results.length > 0 || !failed) cacheSet(cacheKey, results);
  return results;
}

/** Reverse lookup (pin to address label). Never throws; null when unknown or on provider failure. */
export async function reverseLocation(latitude: number, longitude: number): Promise<string | null> {
  if (!validCoords(latitude, longitude)) return null;
  // ~11 m grid so repeated pin nudges hit the cache.
  const lat = latitude.toFixed(4);
  const lng = longitude.toFixed(4);
  const cacheKey = hashKey('r', lat, lng);
  const cached = cacheGet<string | null>(cacheKey);
  if (cached !== undefined) return cached;

  let label: string | null = null;
  let failed = false;
  try {
    const url = new URL('/reverse', env.GEOCODING_BASE_URL);
    url.searchParams.set('lat', lat);
    url.searchParams.set('lon', lng);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('zoom', '18');
    const body = await getJson(primaryRequest, url) as NominatimItem | null;
    label = body?.display_name ? body.display_name.slice(0, 300) : null;
  } catch {
    failed = true;
  }

  if (!label) {
    try {
      const url = new URL('/reverse', env.GEOCODING_FALLBACK_BASE_URL);
      url.searchParams.set('lat', lat);
      url.searchParams.set('lon', lng);
      label = fromPhoton(await getJson(fallbackRequest, url))[0]?.label ?? null;
    } catch {
      failed = true;
    }
  }

  if (label || !failed) cacheSet(cacheKey, label);
  return label;
}
