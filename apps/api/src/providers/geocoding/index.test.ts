import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchIndianLocations } from './index.js';

describe('shop location search', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('limits searches to India, identifies PrintQs and caches repeated queries', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      place_id: 42,
      display_name: 'Example College, Delhi, India',
      lat: '28.5455021',
      lon: '77.1902005',
    }]), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await searchIndianLocations('Example College Delhi 110016');
    const second = await searchIndianLocations('  Example   College Delhi 110016  ');

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      id: '42',
      label: 'Example College, Delhi, India',
      latitude: 28.5455021,
      longitude: 77.1902005,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('countrycodes=in');
    expect(String(url)).toContain('limit=5');
    expect(options?.headers).toMatchObject({
      Referer: 'https://printqs.com/',
      'User-Agent': expect.stringContaining('PrintQs'),
    });
  });
});
