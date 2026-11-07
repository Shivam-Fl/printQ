import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
const google = vi.hoisted(() => ({ available: true, suggest: vi.fn(), reverse: vi.fn() }));
vi.mock('../api.js', () => ({ api: apiMock }));
vi.mock('./googleMaps.js', () => ({
  googleMapsAvailable: () => google.available,
  createGoogleSearch: () => google.suggest,
  googleReverseLabel: google.reverse,
}));

import { createPlaceSearch, reverseLabel } from './geocode.js';

describe('geocode with a Google key', () => {
  beforeEach(() => {
    apiMock.mockReset();
    google.suggest.mockReset();
    google.reverse.mockReset();
    google.available = true;
  });

  it('lists Google suggestions and resolves coordinates only on pick', async () => {
    const resolve = vi.fn().mockResolvedValue({ latitude: 19.27, longitude: 73.03 });
    google.suggest.mockResolvedValue([{ id: 'p1', text: 'Shanti Avenue Co Op.Society, Anjurphata, Bhiwandi, Maharashtra, India', resolve }]);
    const search = createPlaceSearch();
    const [hit] = await search('Shanti Avenue', { latitude: 19, longitude: 73 });
    expect(google.suggest).toHaveBeenCalledWith('Shanti Avenue', { latitude: 19, longitude: 73 });
    expect(hit?.label).toBe('Shanti Avenue Co Op.Society, Anjurphata, Bhiwandi, Maharashtra');
    expect(resolve).not.toHaveBeenCalled();
    expect(await hit?.resolve()).toEqual({
      id: 'p1', latitude: 19.27, longitude: 73.03, label: 'Shanti Avenue Co Op.Society, Anjurphata, Bhiwandi, Maharashtra',
    });
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('falls back to the API search when Google fails, and skips short queries', async () => {
    google.suggest.mockRejectedValue(new Error('REQUEST_DENIED'));
    apiMock.mockResolvedValue({ results: [{ id: 'o1', label: 'Thane, Maharashtra', latitude: 19.2, longitude: 72.97 }] });
    const search = createPlaceSearch();
    expect(await search('ab')).toEqual([]);
    const [hit] = await search('Thane');
    expect(await hit?.resolve()).toEqual({ id: 'o1', label: 'Thane, Maharashtra', latitude: 19.2, longitude: 72.97 });
  });

  it('uses the API search when Google is unavailable', async () => {
    google.available = false;
    apiMock.mockResolvedValue({ results: [] });
    expect(await createPlaceSearch()('Thane')).toEqual([]);
    expect(google.suggest).not.toHaveBeenCalled();
  });

  it('reverse-labels a pin with Google, falling back to the API on error or no result', async () => {
    google.reverse.mockResolvedValueOnce('Halar Nagar Rd, Bhiwandi, Bhiwandi, Maharashtra 421302, India');
    expect(await reverseLabel(19.27, 73.03)).toBe('Halar Nagar Rd, Bhiwandi, Maharashtra 421302');
    expect(apiMock).not.toHaveBeenCalled();

    google.reverse.mockRejectedValueOnce(new Error('ZERO_RESULTS'));
    apiMock.mockResolvedValueOnce({ label: 'Bhiwandi' });
    expect(await reverseLabel(19.27, 73.03)).toBe('Bhiwandi');

    google.reverse.mockResolvedValueOnce(null);
    apiMock.mockResolvedValueOnce({ label: null });
    expect(await reverseLabel(19.27, 73.03)).toBeNull();
  });
});
