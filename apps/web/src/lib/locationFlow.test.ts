import { describe, expect, it } from 'vitest';
import { PINNED_LOCATION } from './geocode.js';
import {
  addressAfterReverse, autoSearchQuery,
  buildLocationSave, postLoginPath, REGISTER_PIN_KEY, shopLoginPath, SEARCH_EMPTY_MESSAGE, SEARCH_FOUND_MESSAGE,
  searchMessage, stashRegisterPin, takeRegisterPin,
} from './locationFlow.js';

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('location editor: pin-only save', () => {
  it('saves a pin with no typed address as "Pinned location"', () => {
    expect(buildLocationSave({ latitude: 12.5, longitude: 77.25 }, '')).toEqual({
      latitude: 12.5, longitude: 77.25, address: PINNED_LOCATION,
    });
    expect(buildLocationSave({ latitude: 12.5, longitude: 77.25 }, '   ')?.address).toBe(PINNED_LOCATION);
  });
  it('keeps a typed address, trimmed', () => {
    expect(buildLocationSave({ latitude: 1, longitude: 2 }, '  12 Market Road ')?.address).toBe('12 Market Road');
  });
  it('accepts a pin on the equator or meridian (0 is a real coordinate)', () => {
    expect(buildLocationSave({ latitude: 0, longitude: 0 }, 'x')).not.toBeNull();
  });
  it('refuses to save without a full pin', () => {
    expect(buildLocationSave({ latitude: null, longitude: null }, 'x')).toBeNull();
    expect(buildLocationSave({ latitude: 1, longitude: null }, 'x')).toBeNull();
  });
});

describe('location editor: empty-search fallback', () => {
  it('tells the owner to drop a pin and type an address when nothing is found', () => {
    const message = searchMessage([]);
    expect(message).toBe(SEARCH_EMPTY_MESSAGE);
    expect(message).toMatch(/click the map/i);
    expect(message).toMatch(/type your address/i);
  });
  it('asks to pick a match when there are results', () => {
    expect(searchMessage([{ id: '1', label: 'A', latitude: 1, longitude: 2 }])).toBe(SEARCH_FOUND_MESSAGE);
  });
});

describe('register pin hand-off', () => {
  it('passes coordinates once, then clears them', () => {
    const store = memoryStore();
    stashRegisterPin(12.9716, 77.5946, store);
    expect(takeRegisterPin(store)).toEqual({ latitude: 12.9716, longitude: 77.5946 });
    expect(store.data.has(REGISTER_PIN_KEY)).toBe(false);
    expect(takeRegisterPin(store)).toBeNull();
  });
  it('ignores junk and out-of-range values', () => {
    const store = memoryStore();
    store.setItem(REGISTER_PIN_KEY, '{"latitude":"x","longitude":1}');
    expect(takeRegisterPin(store)).toBeNull();
    store.setItem(REGISTER_PIN_KEY, '{"latitude":95,"longitude":1}');
    expect(takeRegisterPin(store)).toBeNull();
    store.setItem(REGISTER_PIN_KEY, 'not json');
    expect(takeRegisterPin(store)).toBeNull();
  });
  it('does nothing when storage is unavailable', () => {
    expect(() => stashRegisterPin(1, 2, null)).not.toThrow();
    expect(takeRegisterPin(null)).toBeNull();
  });
});

describe('register pin reverse lookup', () => {
  it('fills an empty or placeholder address with the found label', () => {
    expect(addressAfterReverse('', '12 Market Road')).toBe('12 Market Road');
    expect(addressAfterReverse(PINNED_LOCATION, '12 Market Road')).toBe('12 Market Road');
  });
  it('never overwrites text the owner typed', () => {
    expect(addressAfterReverse('Gate 2, College Road', '12 Market Road')).toBe('Gate 2, College Road');
  });
  it('keeps the current value when the lookup finds nothing', () => {
    expect(addressAfterReverse('', null)).toBe('');
    expect(buildLocationSave({ latitude: 1, longitude: 2 }, addressAfterReverse('', null))?.address).toBe(PINNED_LOCATION);
  });
});

describe('post-login destination', () => {
  const live = { ready: true, verification: { publishedAt: '2026-11-01T00:00:00Z' } };
  const fresh = { ready: false, verification: { publishedAt: null } };

  it('keeps ?next for any same-site dashboard page', () => {
    expect(postLoginPath('/dashboard/setup')).toBe('/dashboard/setup');
    expect(postLoginPath('/dashboard/settings', fresh)).toBe('/dashboard/settings');
    expect(postLoginPath('/dashboard/settings#prices', live)).toBe('/dashboard/settings#prices');
    expect(postLoginPath('/dashboard', fresh)).toBe('/dashboard');
  });
  it('ignores off-site, odd or looping next values', () => {
    for (const next of ['https://evil.example', '//evil.example', '/dashboard//evil.example', '/dashboard/../admin',
      '/dashboardx', '/admin', '/dashboard\\evil', '/dashboard/login', '/dashboard/register?x=1', 'javascript:alert(1)']) {
      expect(postLoginPath(next, live)).toBe('/dashboard');
    }
  });
  it('sends a shop that is not live yet to setup, a live one to the queue', () => {
    expect(postLoginPath(null, fresh)).toBe('/dashboard/setup');
    expect(postLoginPath(null, { ...fresh, visibility: { state: 'pending_review', reason: null } })).toBe('/dashboard/setup');
    expect(postLoginPath(null, live)).toBe('/dashboard');
    // Already-live shops with the PC off, paused or campus-hidden see the explanation on the queue.
    expect(postLoginPath(null, { ...fresh, visibility: { state: 'live_pc_offline', reason: null } })).toBe('/dashboard');
    expect(postLoginPath(null, { ...fresh, visibility: { state: 'hidden_by_admin', reason: 'Spam' } })).toBe('/dashboard');
  });
  it('falls back to the queue when setup status could not load', () => {
    expect(postLoginPath(null)).toBe('/dashboard');
    expect(postLoginPath(null, null)).toBe('/dashboard');
  });
});

describe('location denied: register address search', () => {
  it('searches the typed address, trimmed', () => {
    expect(autoSearchQuery('  Shop 4, Gokhale Road, Thane ')).toBe('Shop 4, Gokhale Road, Thane');
  });
  it('skips empty, too short or placeholder addresses', () => {
    expect(autoSearchQuery('')).toBeNull();
    expect(autoSearchQuery(' ab ')).toBeNull();
    expect(autoSearchQuery(PINNED_LOCATION)).toBeNull();
  });
});

describe('shopLoginPath (SLS-7)', () => {
  it('keeps the ?next another guard already set (ShopNav and the page both redirect)', () => {
    const first = shopLoginPath('/dashboard/history');
    expect(shopLoginPath(first)).toBe(first);
  });
  it('sends the owner back to the dashboard page they opened', () => {
    expect(shopLoginPath('/dashboard/settings#prices')).toBe('/dashboard/login?next=%2Fdashboard%2Fsettings%23prices');
    expect(postLoginPath(decodeURIComponent(shopLoginPath('/dashboard/history').split('next=')[1]!))).toBe('/dashboard/history');
  });
  it('uses the plain login page for the queue or anything odd', () => {
    expect(shopLoginPath('/dashboard')).toBe('/dashboard/login');
    expect(shopLoginPath('/dashboard/')).toBe('/dashboard/login');
    expect(shopLoginPath('/dashboard/login')).toBe('/dashboard/login');
    expect(shopLoginPath('/dashboard/x/../login')).toBe('/dashboard/login');
    expect(shopLoginPath('//evil.example')).toBe('/dashboard/login');
  });
});
