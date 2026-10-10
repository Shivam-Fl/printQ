/** Pure helpers behind the shop Settings form (kept out of the component so they are unit-tested). */

export interface PaperDraft {
  id: string;
  label: string;
  bwPaise: number;
  colorPaise: number | null;
}
export interface BindingDraft {
  id: string;
  label: string;
  paise: number;
}
export interface OptionsDraft {
  papers: PaperDraft[];
  bindings: BindingDraft[];
  duplexEnabled: boolean;
}

/** Everything the Settings form can change in one PATCH /api/shop/me. */
export interface SettingsDraft {
  name: string;
  address: string;
  campusId: string | null;
  latitude: number | null;
  longitude: number | null;
  checkInRadiusM: number;
  counterCapacity: number;
  revealGraceSeconds: number;
  autoAssignEnabled: boolean;
  counterUpiVpa: string | null;
  counterUpiPayeeName: string | null;
  printOptions: OptionsDraft;
}

// ---- price text fields (OWN-3) -------------------------------------------

/** Typing accepts digits with at most two decimals; everything else is ignored. */
const TYPING = /^\d{0,5}(\.\d{0,2})?$/;

/** Next text for a controlled price input: the new text if it is a plausible price-in-progress, else unchanged. */
export function typePrice(previous: string, next: string): string {
  return TYPING.test(next) ? next : previous;
}

export interface PriceParse {
  paise?: number | null;
  error?: string;
}

/**
 * Parse price text to integer paise using string maths (no float drift).
 * Empty is allowed for optional fields (colour price) and reported for required ones.
 */
export function parseRupees(text: string, opts: { required: boolean; maxPaise?: number }): PriceParse {
  const value = text.trim();
  if (value === '' || value === '.') {
    return opts.required ? { error: 'Enter a price (use 0 for free)' } : { paise: null };
  }
  if (!/^\d*\.?\d{0,2}$/.test(value)) return { error: 'Enter a price like 2.50' };
  const [whole = '', fraction = ''] = value.split('.');
  const paise = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0'));
  if (opts.maxPaise != null && paise > opts.maxPaise) {
    return { error: `Price can be at most ₹${(opts.maxPaise / 100).toLocaleString('en-IN')}` };
  }
  return { paise };
}

/** Tidy a valid price on blur: "2.5" -> "2.50". Empty stays empty. */
export function formatRupeesField(text: string): string {
  const parsed = parseRupees(text, { required: false });
  if (parsed.error || parsed.paise == null) return text.trim() === '.' ? '' : text;
  return (parsed.paise / 100).toFixed(2);
}

/** Initial text for a stored price. */
export function priceText(paise: number | null): string {
  return paise == null ? '' : (paise / 100).toFixed(2);
}

// ---- changed-fields-only save (OWN-1 / OWN-5) ----------------------------

const SCALAR_KEYS = [
  'name',
  'address',
  'campusId',
  'checkInRadiusM',
  'counterCapacity',
  'revealGraceSeconds',
  'autoAssignEnabled',
] as const;

/** JSON with object keys sorted: PostgreSQL jsonb does not preserve key order, so compare canonically. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v);
}
const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * Build the PATCH body from only what the owner actually changed. Re-sending
 * untouched fields is what used to unpublish a verified shop on any save, and
 * made a stale tab overwrite newer values from another tab.
 */
export function buildSettingsPatch(
  original: SettingsDraft,
  draft: SettingsDraft,
  printOptionsVersion: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of SCALAR_KEYS) {
    if (draft[key] !== original[key]) patch[key] = draft[key];
  }
  if (draft.latitude !== original.latitude || draft.longitude !== original.longitude) {
    patch.latitude = draft.latitude;
    patch.longitude = draft.longitude;
  }
  if (draft.counterUpiVpa !== original.counterUpiVpa || draft.counterUpiPayeeName !== original.counterUpiPayeeName) {
    patch.counterUpiVpa = draft.counterUpiVpa;
    patch.counterUpiPayeeName = draft.counterUpiPayeeName;
  }
  if (!sameJson(draft.printOptions, original.printOptions)) {
    patch.printOptions = draft.printOptions;
    patch.expectedPrintOptionsVersion = printOptionsVersion;
  }
  return patch;
}

// ---- coordinate sanity (OWN-10, warning only) ----------------------------

/**
 * A soft hint for obviously wrong pins. Never blocks a save: the product is not
 * India-only, so only exact 0,0 (also rejected server-side) and the classic
 * lat/lng swap for an Indian shop (lat 68-98, lng 6-36) are called out.
 */
export function coordinateWarning(latitude: number | null, longitude: number | null): string | null {
  if (latitude == null || longitude == null) return null;
  if (latitude === 0 && longitude === 0) {
    return 'Coordinates 0, 0 are in the ocean off Africa, not a shop. Choose the entrance on the map.';
  }
  if (latitude >= 68 && latitude <= 98 && longitude >= 6 && longitude <= 36) {
    return 'These look swapped — in India, latitude is about 8–35 and longitude about 68–98. Check the two boxes.';
  }
  if (latitude < 6 || latitude > 37.5 || longitude < 68 || longitude > 98) {
    return 'That location is outside India — check latitude/longitude';
  }
  return null;
}

const EARTH_RADIUS_M = 6_371_000;
/** Mirrors the API's MATERIAL_MOVE_M: smaller moves are GPS jitter and never trigger re-review. */
export const MATERIAL_MOVE_M = 150;

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(bLat - aLat) / 2) ** 2
    + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(rad(bLng - aLng) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

/** True when saving this patch will move an existing counter pin far enough to need a fresh review. */
export function locationChangeNeedsReview(original: SettingsDraft, draft: SettingsDraft): boolean {
  if (original.latitude == null || original.longitude == null) return false;
  if (draft.latitude === original.latitude && draft.longitude === original.longitude) return false;
  if (draft.latitude == null || draft.longitude == null) return true;
  return metersBetween(original.latitude, original.longitude, draft.latitude, draft.longitude) > MATERIAL_MOVE_M;
}
