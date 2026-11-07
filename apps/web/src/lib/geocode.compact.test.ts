import { describe, expect, it } from 'vitest';
import { compactAddress, dedupePlaces } from './geocode.js';

describe('compactAddress', () => {
  it('drops repeated admin levels, sub-districts and the country', () => {
    expect(compactAddress('Kapurbawdi Flyover, Kapurbavadi, Majiwada, Thane, Thane Subdistrict, Thane, Maharashtra, 400609, India'))
      .toBe('Kapurbawdi Flyover, Kapurbavadi, Majiwada, Thane, Maharashtra, 400609');
    expect(compactAddress('Naupada, Thane, Thane Subdistrict, Thane, Maharashtra, 400602, India'))
      .toBe('Naupada, Thane, Maharashtra, 400602');
  });
  it('leaves short labels alone', () => {
    expect(compactAddress('MG Road, Pune, India')).toBe('MG Road, Pune, India');
    expect(compactAddress(' 12 High St ')).toBe('12 High St');
  });
  it('keeps a trailing postcode', () => {
    expect(compactAddress('A, B, C, 400602')).toBe('A, B, C, 400602');
  });
});

describe('dedupePlaces', () => {
  it('drops results that read the same once compacted', () => {
    const label = 'Gokhale Road, Chendani Koliwada, Jambli Naka, Thane, Thane Subdistrict, Thane, Maharashtra, 400602, India';
    const results = dedupePlaces([
      { id: '1', label, latitude: 19.19, longitude: 72.97 },
      { id: '2', label, latitude: 19.191, longitude: 72.971 },
      { id: '3', label: 'Gokhale Road, Naupada, Thane, Maharashtra, 400602, India', latitude: 19.2, longitude: 72.98 },
    ]);
    expect(results.map((r) => r.id)).toEqual(['1', '3']);
    expect(results[0]?.label).toBe('Gokhale Road, Chendani Koliwada, Jambli Naka, Thane, Maharashtra, 400602');
  });
});
