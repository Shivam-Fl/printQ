import { describe, expect, it } from 'vitest';
import {
  autocompleteRequest, GOOGLE_MAPS_CALLBACK, geocoderLabel, googleMapsScriptUrl, placeLabel, SEARCH_BIAS_RADIUS_M,
  textSearchRequest, withoutPlusCodes,
} from './googleMaps.js';

describe('google maps helpers', () => {
  it('builds the async bootstrap url with the key, callback and India region', () => {
    const url = new URL(googleMapsScriptUrl('test-key'));
    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/js');
    expect(url.searchParams.get('key')).toBe('test-key');
    expect(url.searchParams.get('loading')).toBe('async');
    expect(url.searchParams.get('callback')).toBe(GOOGLE_MAPS_CALLBACK);
    expect(url.searchParams.get('region')).toBe('IN');
  });

  it('asks autocomplete for India only, biased to a known point', () => {
    const token = {};
    expect(autocompleteRequest(' Shanti Avenue ', token)).toEqual({ input: 'Shanti Avenue', sessionToken: token, includedRegionCodes: ['in'] });
    expect(autocompleteRequest('Sai Xerox', token, { latitude: 19.2, longitude: 73.1 }).locationBias)
      .toEqual({ center: { lat: 19.2, lng: 73.1 }, radius: SEARCH_BIAS_RADIUS_M });
    expect(autocompleteRequest('Sai Xerox', token, null)).not.toHaveProperty('locationBias');
  });

  it('builds the text-search fallback with Indian formatting and the same bias', () => {
    expect(textSearchRequest(' Sai Xerox Bhiwandi ', { latitude: 19.2, longitude: 73.1 })).toEqual({
      textQuery: 'Sai Xerox Bhiwandi',
      fields: ['id', 'location', 'formattedAddress', 'displayName'],
      region: 'in',
      maxResultCount: 5,
      locationBias: { center: { lat: 19.2, lng: 73.1 }, radius: SEARCH_BIAS_RADIUS_M },
    });
    expect(textSearchRequest('Sai Xerox')).not.toHaveProperty('locationBias');
  });

  it('drops plus codes wherever they appear in an address', () => {
    expect(withoutPlusCodes('Shanti Avenue Co Op.Society, 72GP+32M, Halar nagar road, Anjurphata'))
      .toBe('Shanti Avenue Co Op.Society, Halar nagar road, Anjurphata');
    expect(withoutPlusCodes('XQ3M+8F Bhiwandi, Maharashtra')).toBe('Bhiwandi, Maharashtra');
    expect(withoutPlusCodes('73X8+93M, Maulana Azad Rd')).toBe('Maulana Azad Rd');
    expect(withoutPlusCodes('Shop 4+5, Kalyan Rd')).toBe('Shop 4+5, Kalyan Rd');
    expect(withoutPlusCodes('72GP+32M')).toBe('');
  });

  it('keeps the place name unless the address already contains it', () => {
    expect(placeLabel('Sai Xerox', 'Shop 4, Kalyan Rd, Bhiwandi, Maharashtra 421302, India'))
      .toBe('Sai Xerox, Shop 4, Kalyan Rd, Bhiwandi, Maharashtra 421302, India');
    expect(placeLabel('Gokhale Rd', 'Gokhale Rd, Naupada, Thane West, Thane, Maharashtra 400602, India'))
      .toBe('Gokhale Rd, Naupada, Thane West, Thane, Maharashtra 400602, India');
    expect(placeLabel('shanti avenue', 'Shanti Avenue Co Op.Society, Anjurphata, Bhiwandi')).toBe('Shanti Avenue Co Op.Society, Anjurphata, Bhiwandi');
    expect(placeLabel('Om Sai Ram Xerox', '73X8+93M, Maulana Azad Rd, Bhiwandi, Maharashtra 421302'))
      .toBe('Om Sai Ram Xerox, Maulana Azad Rd, Bhiwandi, Maharashtra 421302');
    expect(placeLabel(null, ' Bhiwandi ')).toBe('Bhiwandi');
    expect(placeLabel('Thane', '')).toBe('Thane');
    expect(placeLabel(undefined, null)).toBeNull();
  });

  it('picks the first readable reverse-geocode address, skipping plus codes', () => {
    expect(geocoderLabel([
      { formatted_address: 'XQ3M+8F Bhiwandi, Maharashtra, India', types: ['plus_code'] },
      { formatted_address: 'Halar Nagar Rd, Anjur Phata, Bhiwandi, Maharashtra 421302, India', types: ['route'] },
    ])).toBe('Halar Nagar Rd, Anjur Phata, Bhiwandi, Maharashtra 421302, India');
    expect(geocoderLabel([{ formatted_address: '7JWV+XQ7, Naupada, Thane, Maharashtra 400602, India', types: ['establishment'] }]))
      .toBe('Naupada, Thane, Maharashtra 400602, India');
    expect(geocoderLabel([{ formatted_address: 'Shanti Avenue, 72GP+32M, Halar nagar road', types: ['establishment'] }]))
      .toBe('Shanti Avenue, Halar nagar road');
    expect(geocoderLabel([{ formatted_address: '  ', types: ['street_address'] }])).toBeNull();
    expect(geocoderLabel([
      { formatted_address: '72FP+W5J, Charnipada Road, ऑडेरा नगर, रहनाळ, महाराष्ट्र 421302, India', types: ['premise'] },
      { formatted_address: '6/A, Anjurphata, Kailasnagar, Rahanal, Maharashtra 421302, India', types: ['street_address'] },
    ])).toBe('6/A, Anjurphata, Kailasnagar, Rahanal, Maharashtra 421302, India');
    expect(geocoderLabel([{ formatted_address: 'Charnipada Road, रहनाळ', types: ['route'] }])).toBe('Charnipada Road, रहनाळ');
    expect(geocoderLabel([])).toBeNull();
  });
});
