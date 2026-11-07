import { describe, expect, it } from 'vitest';
import { PINNED_LOCATION } from './geocode.js';
import {
  accuracyText, addressAfterReverse, autoSearchQuery,
  buildLocationSave, desktopLocationTip, deviceFixMessage, isPreciseFix, locationFailureLead, postLoginPath,
  REGISTER_PIN_KEY, registerFillNote, registerPinFromFix, shopLoginPath, SEARCH_EMPTY_MESSAGE, SEARCH_FOUND_MESSAGE,
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

describe('coarse device fixes are never pinned by themselves (LOC-3)', () => {
  it('treats 100 m or better as precise, anything rougher (or junk) as an area', () => {
    expect(isPreciseFix(5)).toBe(true);
    expect(isPreciseFix(100)).toBe(true);
    expect(isPreciseFix(100.4)).toBe(false);
    expect(isPreciseFix(209)).toBe(false);
    expect(isPreciseFix(25_000)).toBe(false);
    expect(isPreciseFix(Number.NaN)).toBe(false);
    expect(isPreciseFix(-1)).toBe(false);
  });
  it('writes the accuracy in m or km', () => {
    expect(accuracyText(0.2)).toBe('about 1 m');
    expect(accuracyText(209.4)).toBe('about 209 m');
    expect(accuracyText(999.7)).toBe('about 1 km');
    expect(accuracyText(2_480)).toBe('about 2.5 km');
    expect(accuracyText(25_300)).toBe('about 25 km');
  });
  it('asks the owner to tap the entrance for a rough fix and to fine-tune a precise one', () => {
    expect(deviceFixMessage(209)).toBe('We found your area (about 209 m). Tap your shop entrance on the map.');
    expect(deviceFixMessage(12_000)).toBe('We found your area (about 12 km). Tap your shop entrance on the map.');
    expect(deviceFixMessage(Number.NaN)).toBe('We found your area. Tap your shop entrance on the map.');
    expect(deviceFixMessage(40)).toBe('Location found (about 40 m accuracy). Drag the pin if it is a little off.');
  });
});

describe('register "Fill from my location" (LOC-4)', () => {
  it('hands a precise fix to setup, rounded to 6 places', () => {
    expect(registerPinFromFix({ latitude: 19.21834567, longitude: 72.97812349, accuracy: 30 }))
      .toEqual({ latitude: 19.218346, longitude: 72.978123 });
  });
  it('keeps a rough fix to itself, so setup detects again', () => {
    expect(registerPinFromFix({ latitude: 19.2, longitude: 72.9, accuracy: 209 })).toBeNull();
  });
  it('never overwrites a typed address, but may refresh its own earlier fill', () => {
    expect(addressAfterReverse('Shop 7, Janpath Market', 'Janpath Road, New Delhi')).toBe('Shop 7, Janpath Market');
    expect(addressAfterReverse('Shop 7, Janpath Market', 'Janpath Road', 'Connaught Place')).toBe('Shop 7, Janpath Market');
    expect(addressAfterReverse('Connaught Place', 'Janpath Road', 'Connaught Place')).toBe('Janpath Road');
    expect(addressAfterReverse('', 'Janpath Road')).toBe('Janpath Road');
  });
  it('says "off" only when access was refused', () => {
    expect(locationFailureLead(true)).toBe('Location access is off');
    expect(locationFailureLead(false)).toBe('Could not get a location');
  });
  it('explains what happened to the address', () => {
    expect(registerFillNote('kept', 30)).toMatch(/^Kept the address you typed/);
    expect(registerFillNote('filled', 30)).toMatch(/shop number/);
    expect(registerFillNote('filled', 2_400)).toMatch(/about 2\.4 km/);
    expect(registerFillNote('not_found', 30)).toMatch(/Type it in/);
  });
});

describe('desktop app location fallback', () => {
  it('points at this site in Chrome', () => {
    expect(desktopLocationTip('printqs.com')).toBe('Or open printqs.com/dashboard/setup in Chrome on this PC to use its location.');
  });
});
