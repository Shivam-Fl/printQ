import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => vi.fn());
vi.mock('../api.js', () => ({ api: apiMock }));

import {
  addressIsReplaceable, geocodeSearchUrl, PINNED_LOCATION, reverseGeocodeUrl, reverseLabel, searchPlaces,
} from './geocode.js';

describe('geocode client', () => {
  beforeEach(() => apiMock.mockReset());

  it('builds the search url with optional bias', () => {
    expect(geocodeSearchUrl(' Main St 5 ')).toBe('/api/shop/geocode?q=Main+St+5');
    expect(geocodeSearchUrl('cafe', { latitude: 51.5, longitude: -0.12 })).toBe('/api/shop/geocode?q=cafe&lat=51.5&lng=-0.12');
  });
  it('builds the reverse url', () => {
    expect(reverseGeocodeUrl(1.5, 2.5)).toBe('/api/shop/geocode/reverse?lat=1.5&lng=2.5');
  });
  it('does not call the API for short queries', async () => {
    expect(await searchPlaces('ab')).toEqual([]);
    expect(apiMock).not.toHaveBeenCalled();
  });
  it('returns results, and [] when the body has none', async () => {
    apiMock.mockResolvedValueOnce({ results: [{ id: '1', label: 'A', latitude: 1, longitude: 2 }] });
    expect(await searchPlaces('abc')).toHaveLength(1);
    apiMock.mockResolvedValueOnce({});
    expect(await searchPlaces('abc')).toEqual([]);
  });
  it('reverseLabel returns the label, null for null/blank, and null on error', async () => {
    apiMock.mockResolvedValueOnce({ label: ' 12 High St ' });
    expect(await reverseLabel(1, 2)).toBe('12 High St');
    apiMock.mockResolvedValueOnce({ label: null });
    expect(await reverseLabel(1, 2)).toBeNull();
    apiMock.mockRejectedValueOnce(new Error('429'));
    expect(await reverseLabel(1, 2)).toBeNull();
  });
  it('only replaces empty, placeholder or machine-filled addresses', () => {
    expect(addressIsReplaceable('', null)).toBe(true);
    expect(addressIsReplaceable(PINNED_LOCATION, null)).toBe(true);
    expect(addressIsReplaceable('Auto A', 'Auto A')).toBe(true);
    expect(addressIsReplaceable('Typed by owner', 'Auto A')).toBe(false);
  });
});
