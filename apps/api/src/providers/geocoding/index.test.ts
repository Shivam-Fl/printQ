import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reverseLocation, searchLocations } from './index.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const nominatim = [{ place_id: 42, display_name: 'Sharma Xerox, MG Road, Pune, India', lat: '18.5204', lon: '73.8567' }];
const photon = { features: [{
  geometry: { coordinates: [-0.1276, 51.5072] },
  properties: { osm_id: 7, osm_type: 'N', name: 'Corner Print', street: 'High St', housenumber: '4', city: 'London', country: 'United Kingdom' },
}] };

describe('geocoding provider', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.unstubAllGlobals());

  it('searches worldwide (no country restriction), asks for 10 results, biases by lat/lng and caches', async () => {
    const fetchMock = vi.fn(async () => json(nominatim));
    vi.stubGlobal('fetch', fetchMock);
    const bias = { latitude: 18.52, longitude: 73.85 };

    const first = await searchLocations('Sharma Xerox Pune', bias);
    const second = await searchLocations('  Sharma   Xerox Pune ', bias);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({ id: '42', latitude: 18.5204, longitude: 73.8567 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).not.toContain('countrycodes');
    expect(String(url)).toContain('limit=10');
    expect(String(url)).toContain('viewbox=');
    expect(String(url)).toContain('bounded=0');
    expect(options.headers).toMatchObject({ 'User-Agent': expect.stringContaining('PrintQs') });
  });

  it('falls back to Photon when the primary returns nothing', async () => {
    const fetchMock = vi.fn(async (url: URL) =>
      String(url).includes('photon') ? json(photon) : json([]));
    vi.stubGlobal('fetch', fetchMock);

    const results = await searchLocations('Corner Print London');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toEqual([{
      id: 'N7', label: 'Corner Print, High St 4, London, United Kingdom', latitude: 51.5072, longitude: -0.1276,
    }]);
  });

  it('falls back to Photon when the primary errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: URL) =>
      String(url).includes('photon') ? json(photon) : json({}, 503)));
    expect(await searchLocations('Corner Print errors London')).toHaveLength(1);
  });

  it('returns an empty list, never throws, when every provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    expect(await searchLocations('Nowhere At All Outage')).toEqual([]);
  });

  it('does not cache an outage-driven empty result', async () => {
    const down = vi.fn(async () => { throw new Error('down'); });
    vi.stubGlobal('fetch', down);
    expect(await searchLocations('Retry After Outage')).toEqual([]);
    vi.stubGlobal('fetch', vi.fn(async () => json(nominatim)));
    expect(await searchLocations('Retry After Outage')).toHaveLength(1);
  });

  it('reverse lookup returns a label, falls back, and gives null on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ display_name: 'MG Road, Pune, India' })));
    expect(await reverseLocation(18.5204, 73.8567)).toBe('MG Road, Pune, India');

    vi.stubGlobal('fetch', vi.fn(async (url: URL) =>
      String(url).includes('photon') ? json(photon) : json({}, 500)));
    expect(await reverseLocation(51.5072, -0.1276)).toBe('Corner Print, High St 4, London, United Kingdom');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await reverseLocation(1.2345, 2.3456)).toBeNull();
    expect(await reverseLocation(999, 0)).toBeNull();
  });
});
