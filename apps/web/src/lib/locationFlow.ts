/** Pure helpers behind the shop location editor and setup, kept DOM-free so they are unit-testable. */
import { addressIsReplaceable, MIN_QUERY_LENGTH, PINNED_LOCATION, type PlaceResult } from './geocode.js';
import { stillOnboarding, visibilityState, type SetupSnapshot } from './setupSteps.js';

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

/** Any same-site /dashboard path: no scheme, no "//", no "..", and never back to login or register. */
const DASHBOARD_PATH = /^\/dashboard(?:\/[\w-]+)*\/?(?:[?#][^\s\\]*)?$/;
const AUTH_PATHS = new Set(['/dashboard/login', '/dashboard/register']);

function safeDashboardNext(next: string | null | undefined): string | null {
  if (!next || !DASHBOARD_PATH.test(next)) return null;
  const path = (next.split(/[?#]/)[0] ?? '').replace(/\/$/, '');
  return AUTH_PATHS.has(path) ? null : next;
}

/**
 * /dashboard/login that brings the owner back to this page after signing in, so a deep link
 * like /dashboard/settings#prices still works when the session had ended.
 */
export function shopLoginPath(
  here: string = typeof window === 'undefined' ? '' : `${window.location.pathname}${window.location.search}${window.location.hash}`,
): string {
  // ShopNav and the page both guard the session; whichever runs second must keep the first one's ?next.
  if (/^\/dashboard\/login(?:[?#]|$)/.test(here)) return here;
  const back = safeDashboardNext(here);
  return back && back.replace(/\/$/, '') !== '/dashboard' ? `/dashboard/login?next=${encodeURIComponent(back)}` : '/dashboard/login';
}

/**
 * Where to go after a shop login. A safe ?next (any /dashboard page) wins. Otherwise a shop
 * that has never gone live lands on the setup checklist and a live one on the queue.
 * `setup` is the GET /api/shop/setup-status payload; null/undefined (not loaded) means the queue.
 */
export function postLoginPath(
  next: string | null | undefined,
  setup?: Pick<SetupSnapshot, 'ready' | 'visibility' | 'verification'> | null,
): string {
  const safe = safeDashboardNext(next);
  if (safe) return safe;
  if (setup && stillOnboarding(visibilityState(setup))) return '/dashboard/setup';
  return '/dashboard';
}

/** The address typed at register, as a search to run when the device location is off. Null when not worth a lookup. */
export function autoSearchQuery(address: string): string | null {
  const text = address.trim();
  if (text.length < MIN_QUERY_LENGTH || text === PINNED_LOCATION) return null;
  return text;
}

/**
 * Address to show after reverse-looking-up a pin handed over from register: the found label,
 * but only while the current text is empty or machine-filled. Typed text is never overwritten,
 * and a failed lookup (null) keeps what is there (an empty box saves as "Pinned location").
 */
export function addressAfterReverse(current: string, label: string | null, lastFilled: string | null = null): string {
  if (!label || !addressIsReplaceable(current, lastFilled)) return current;
  return label;
}

/**
 * A device fix this close may place the pin by itself. Anything rougher (a 200 m Wi-Fi guess,
 * a city-level IP fix) only shows the area: students check in within 20-200 m of the saved
 * pin, so a guessed pin would make them fail at the real counter.
 */
export const PRECISE_FIX_M = 100;

export function isPreciseFix(accuracy: number): boolean {
  return Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= PRECISE_FIX_M;
}

/** "about 40 m", "about 2.5 km", "about 25 km". */
export function accuracyText(meters: number): string {
  const rounded = Math.max(1, Math.round(meters));
  if (rounded < 1000) return `about ${rounded} m`;
  const km = meters / 1000;
  return `about ${km < 10 ? Number(km.toFixed(1)) : Math.round(km)} km`;
}

/** What the editor says after a device fix: a precise one is pinned, a rough one only shows the area. */
export function deviceFixMessage(accuracy: number): string {
  if (isPreciseFix(accuracy)) return `Location found (${accuracyText(accuracy)} accuracy). Drag the pin if it is a little off.`;
  if (!Number.isFinite(accuracy) || accuracy < 0) return 'We found your area. Tap your shop entrance on the map.';
  return `We found your area (${accuracyText(accuracy)}). Tap your shop entrance on the map.`;
}

/** Register hands its fix to the pin step only when it is precise; otherwise setup finds the location itself. */
export function registerPinFromFix(coords: { latitude: number; longitude: number; accuracy: number }): { latitude: number; longitude: number } | null {
  if (!isPreciseFix(coords.accuracy)) return null;
  return { latitude: Number(coords.latitude.toFixed(6)), longitude: Number(coords.longitude.toFixed(6)) };
}

/** Lead-in (no full stop) when the device gave no location: "off" only when access was refused. */
export function locationFailureLead(denied: boolean): string {
  return denied ? 'Location access is off' : 'Could not get a location';
}

/** Register "Fill from my location": what to tell the owner after the lookup. */
export function registerFillNote(outcome: 'filled' | 'kept' | 'not_found', accuracy: number): string {
  const precise = isPreciseFix(accuracy);
  if (outcome === 'not_found') return 'Could not find an address here. Type it in; you will pin the exact spot next.';
  if (outcome === 'kept') {
    return precise
      ? 'Kept the address you typed. Your location will be used for the map pin.'
      : 'Kept the address you typed. You will pin the exact spot next.';
  }
  return precise
    ? 'Filled in from your location. Add your shop number or a landmark.'
    : `Filled in from your rough location (${accuracyText(accuracy)}). Check it and add your shop number; you will tap your exact entrance on the map next.`;
}

/** Extra line when location fails inside the PrintQs Shop desktop app: the PC's Chrome can usually locate it. */
export function desktopLocationTip(host: string): string {
  return `Or open ${host}/dashboard/setup in Chrome on this PC to use its location.`;
}
