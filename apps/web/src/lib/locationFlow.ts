/** Pure helpers behind the shop location editor and setup, kept DOM-free so they are unit-testable. */
import { addressIsReplaceable, PINNED_LOCATION, type PlaceResult } from './geocode.js';

export const SEARCH_FOUND_MESSAGE = 'Choose the closest match, then drag the pin to the exact entrance.';
export const SEARCH_EMPTY_MESSAGE = 'Nothing found. That is fine: click the map to drop the pin and type your address below.';
export const SEARCH_FAILED_MESSAGE = 'Address search is unavailable right now. Click the map to drop the pin and type your address.';

/** Message shown after a search; an empty result is a normal outcome that points at the pin fallback. */
export function searchMessage(results: PlaceResult[]): string {
  return results.length ? SEARCH_FOUND_MESSAGE : SEARCH_EMPTY_MESSAGE;
}

export interface LocationSaveBody {
  latitude: number;
  longitude: number;
  address: string;
}

/** Body for PATCH /api/shop/me. Null without a pin; a pin alone saves with the "Pinned location" address. */
export function buildLocationSave(
  pin: { latitude: number | null; longitude: number | null },
  address: string,
): LocationSaveBody | null {
  if (pin.latitude == null || pin.longitude == null) return null;
  return { latitude: pin.latitude, longitude: pin.longitude, address: address.trim() || PINNED_LOCATION };
}

export const REGISTER_PIN_KEY = 'printq.register-pin';

interface PinStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStore(): PinStore | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

/** Register found the owner's coordinates already; keep them for the pin step so no second prompt appears. */
export function stashRegisterPin(latitude: number, longitude: number, store: PinStore | null = defaultStore()): void {
  try {
    store?.setItem(REGISTER_PIN_KEY, JSON.stringify({ latitude, longitude }));
  } catch { /* storage denied: the setup step just asks again */ }
}

/** Reads and clears the stashed pin (one use). */
export function takeRegisterPin(store: PinStore | null = defaultStore()): { latitude: number; longitude: number } | null {
  try {
    const raw = store?.getItem(REGISTER_PIN_KEY);
    if (!raw) return null;
    store?.removeItem(REGISTER_PIN_KEY);
    const value = JSON.parse(raw) as { latitude?: unknown; longitude?: unknown };
    const { latitude, longitude } = value;
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return null;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  } catch {
    return null;
  }
}

/** Where to go after a shop login: the setup page when asked (tray link), otherwise the dashboard. Same-site paths only. */
export function postLoginPath(next: string | null | undefined): string {
  if (next === '/dashboard/setup') return '/dashboard/setup';
  return '/dashboard';
}

/**
 * Address to show after reverse-looking-up a pin handed over from register: the found label,
 * but only while the current text is empty or machine-filled. Typed text is never overwritten,
 * and a failed lookup (null) keeps what is there (an empty box saves as "Pinned location").
 */
export function addressAfterReverse(current: string, label: string | null): string {
  if (!label || !addressIsReplaceable(current, null)) return current;
  return label;
}
