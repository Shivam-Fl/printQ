import { describe, expect, it } from 'vitest';
import { PINNED_LOCATION } from './geocode.js';
import {
  buildLocationSave, postLoginPath, REGISTER_PIN_KEY, SEARCH_EMPTY_MESSAGE, SEARCH_FOUND_MESSAGE,
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

describe('post-login destination', () => {
  it('lands on setup from the tray link, otherwise on the dashboard', () => {
    expect(postLoginPath('/dashboard/setup')).toBe('/dashboard/setup');
    expect(postLoginPath(null)).toBe('/dashboard');
    expect(postLoginPath('https://evil.example')).toBe('/dashboard');
    expect(postLoginPath('/dashboard/settings')).toBe('/dashboard');
  });
});
