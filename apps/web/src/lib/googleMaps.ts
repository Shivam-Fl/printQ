/**
 * Google Maps Platform in the browser (map, Places autocomplete, reverse geocoding), used only
 * when VITE_GOOGLE_MAPS_API_KEY is set. That key is a public browser key, restricted by HTTP
 * referrer and API in the Google Cloud console. No npm dependency: the official bootstrap is
 * loaded with a script tag (loading=async + importLibrary). If it cannot load or the key is
 * refused, everything falls back to Leaflet + the API geocoder for the rest of the session.
 */

export const GOOGLE_MAPS_API_KEY: string = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
export const GOOGLE_MAPS_CALLBACK = '__printqsGoogleMapsReady';
/** Autocomplete prefers matches within this distance of a known point (a soft bias, not a filter). */
export const SEARCH_BIAS_RADIUS_M = 20_000;

/* Just the parts of the Maps JS API used here (no @types/google.maps dependency). */
export interface LatLngLiteral { lat: number; lng: number }
interface LatLng { lat(): number; lng(): number }
interface MapsEventListener { remove(): void }
export interface MapMouseEvent { latLng?: LatLng | null }
export interface GoogleMap {
  setCenter(at: LatLngLiteral | LatLng): void;
  setZoom(zoom: number): void;
  getZoom(): number | undefined;
  panTo(at: LatLngLiteral): void;
  fitBounds(bounds: unknown, padding?: number): void;
  addListener(event: 'click', handler: (event: MapMouseEvent) => void): MapsEventListener;
}
export interface GoogleMarker {
  setPosition(at: LatLngLiteral): void;
  addListener(event: 'dragend', handler: (event: MapMouseEvent) => void): MapsEventListener;
}
export interface GoogleCircle { setMap(map: GoogleMap | null): void; getBounds(): unknown }
export interface MapKit {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GoogleMap;
  Marker: new (options: Record<string, unknown>) => GoogleMarker;
  Circle: new (options: Record<string, unknown>) => GoogleCircle;
  ControlPosition: { LEFT_BOTTOM: unknown };
}
interface Place {
  id?: string;
  location?: LatLng | null;
  formattedAddress?: string | null;
  displayName?: string | null;
  fetchFields(options: { fields: string[] }): Promise<unknown>;
}
interface PlacePrediction { placeId: string; text: { text: string }; toPlace(): Place }
interface PlacesLibrary {
  AutocompleteSessionToken: new () => object;
  AutocompleteSuggestion: {
    fetchAutocompleteSuggestions(request: ReturnType<typeof autocompleteRequest>): Promise<{ suggestions: { placePrediction: PlacePrediction | null }[] }>;
  };
  Place: { searchByText(request: ReturnType<typeof textSearchRequest>): Promise<{ places: Place[] }> };
}
interface GeocoderResult { formatted_address?: string; types?: readonly string[] }
interface GeocodingLibrary {
  Geocoder: new () => { geocode(request: { location: LatLngLiteral }): Promise<{ results: GeocoderResult[] }> };
}
type BootWindow = Window & {
  google?: { maps?: { importLibrary?: (name: string) => Promise<unknown> } };
  gm_authFailure?: () => void;
  [GOOGLE_MAPS_CALLBACK]?: () => void;
};

type Bias = { latitude: number; longitude: number } | null | undefined;

let failed = false;
const listeners = new Set<() => void>();
let loading: Promise<void> | null = null;

/** True while a key is configured and Google has not failed to load or refused the key. */
export function googleMapsAvailable(): boolean {
  return GOOGLE_MAPS_API_KEY !== '' && !failed;
}

/** For useSyncExternalStore: called once when Google turns out to be unusable. */
export function subscribeGoogleMaps(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function markGoogleMapsFailed(): void {
  if (failed) return;
  failed = true;
  listeners.forEach((listener) => listener());
}

export function googleMapsScriptUrl(key: string): string {
  // region=IN: Indian borders and address formats; language=en: matches the rest of the app.
  const params = new URLSearchParams({ key, loading: 'async', callback: GOOGLE_MAPS_CALLBACK, region: 'IN', language: 'en' });
  return `https://maps.googleapis.com/maps/api/js?${params.toString()}`;
}

/** Adds the bootstrap script once; resolves when google.maps.importLibrary is ready. */
export function loadGoogleMaps(): Promise<void> {
  if (!googleMapsAvailable()) return Promise.reject(new Error('Google Maps is not available'));
  loading ??= new Promise<void>((resolve, reject) => {
    const w = window as BootWindow;
    // Google calls this when the key is refused (e.g. a host missing from the referrer list).
    w.gm_authFailure = markGoogleMapsFailed;
    w[GOOGLE_MAPS_CALLBACK] = () => resolve();
    const script = document.createElement('script');
    script.src = googleMapsScriptUrl(GOOGLE_MAPS_API_KEY);
    script.async = true;
    script.onerror = () => {
      markGoogleMapsFailed();
      reject(new Error('Google Maps failed to load'));
    };
    document.head.append(script);
  });
  return loading;
}

async function googleLibrary<T>(name: string): Promise<T> {
  await loadGoogleMaps();
  const importLibrary = (window as BootWindow).google?.maps?.importLibrary;
  if (!importLibrary) throw new Error('Google Maps is not available');
  return (await importLibrary(name)) as T;
}

export async function loadMapKit(): Promise<MapKit> {
  const [maps, marker, core] = await Promise.all([
    googleLibrary<Pick<MapKit, 'Map' | 'Circle'>>('maps'),
    googleLibrary<Pick<MapKit, 'Marker'>>('marker'),
    googleLibrary<Pick<MapKit, 'ControlPosition'>>('core'),
  ]);
  return { Map: maps.Map, Circle: maps.Circle, Marker: marker.Marker, ControlPosition: core.ControlPosition };
}

const round6 = (value: number) => Number(value.toFixed(6));

const biasCircle = (bias: Bias) => (bias
  ? { locationBias: { center: { lat: bias.latitude, lng: bias.longitude }, radius: SEARCH_BIAS_RADIUS_M } }
  : {});

/** Places (New) autocomplete request: India only, nearby matches first when a point is known. */
export function autocompleteRequest(input: string, sessionToken: object, bias?: Bias) {
  return { input: input.trim(), sessionToken, includedRegionCodes: ['in'], ...biasCircle(bias) };
}

/** Text search, the fallback when autocomplete finds nothing: Indian formatting, nearby first. */
export function textSearchRequest(textQuery: string, bias?: Bias) {
  return {
    textQuery: textQuery.trim(),
    fields: ['id', 'location', 'formattedAddress', 'displayName'],
    region: 'in',
    maxResultCount: 5,
    ...biasCircle(bias),
  };
}

const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?:\s+|$)/;

/** Drops plus codes ("72GP+32M", "XQ3M+8F Bhiwandi") from an address: they mean nothing to students. */
export function withoutPlusCodes(address: string): string {
  return address.split(',').map((part) => part.trim().replace(PLUS_CODE, '').trim()).filter(Boolean).join(', ');
}

/** "Sai Xerox" + "Shop 4, Kalyan Rd, Bhiwandi…": keep the place name unless the address already has it. */
export function placeLabel(name: string | null | undefined, address: string | null | undefined): string | null {
  const place = name?.trim() ?? '';
  const where = withoutPlusCodes(address ?? '');
  if (!where) return place || null;
  if (!place || where.toLocaleLowerCase('en').includes(place.toLocaleLowerCase('en'))) return where;
  return `${place}, ${where}`;
}

/** Devanagari through Sinhala: some Indian addresses come back in the local script even with language=en. */
const INDIC_SCRIPT = /[\u0900-\u0DFF]/;

/**
 * Most specific reverse-geocode address for an English UI: skips plus-code results and prefers
 * one written in English ("6/A, Anjurphata, Rahanal…" over "Charnipada Road, ऑडेरा नगर…").
 */
export function geocoderLabel(results: readonly GeocoderResult[]): string | null {
  const labels = results
    .filter((result) => !result.types?.includes('plus_code'))
    .map((result) => withoutPlusCodes(result.formatted_address ?? ''))
    .filter(Boolean);
  return labels.find((label) => !INDIC_SCRIPT.test(label)) ?? labels[0] ?? null;
}

export async function googleReverseLabel(latitude: number, longitude: number): Promise<string | null> {
  const { Geocoder } = await googleLibrary<GeocodingLibrary>('geocoding');
  const { results } = await new Geocoder().geocode({ location: { lat: latitude, lng: longitude } });
  return geocoderLabel(results);
}

export interface GooglePlaceHit {
  id: string;
  text: string;
  /** Coordinates; a suggestion fetches them only when the owner picks it. */
  resolve: () => Promise<{ latitude: number; longitude: number } | null>;
}

const position = (at: LatLng) => ({ latitude: round6(at.lat()), longitude: round6(at.lng()) });

/**
 * One autocomplete session per search: searches share a session token until a pick fetches the
 * place (which ends the session), so Google bills the searches and the pick as one lookup.
 * Autocomplete needs every word to match ("Sai Xerox Bhiwandi" finds nothing); then a text
 * search, which is looser, lists nearby places instead.
 */
export function createGoogleSearch() {
  let token: object | null = null;
  return async (text: string, bias?: Bias): Promise<GooglePlaceHit[]> => {
    const places = await googleLibrary<PlacesLibrary>('places');
    token ??= new places.AutocompleteSessionToken();
    const session = token;
    const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions(autocompleteRequest(text, session, bias));
    const hits = suggestions.flatMap(({ placePrediction: prediction }): GooglePlaceHit[] => {
      if (!prediction) return [];
      let picked: ReturnType<GooglePlaceHit['resolve']> | null = null;
      const resolve = async () => {
        const place = prediction.toPlace();
        // Location only (Essentials): the label is the suggestion the owner picked.
        await place.fetchFields({ fields: ['location'] });
        if (token === session) token = null;
        return place.location ? position(place.location) : null;
      };
      return [{
        id: prediction.placeId,
        text: prediction.text.text,
        resolve: () => (picked ??= resolve().catch((error: unknown) => { picked = null; throw error; })),
      }];
    });
    if (hits.length) return hits;
    const { places: found } = await places.Place.searchByText(textSearchRequest(text, bias));
    return found.flatMap((place, index): GooglePlaceHit[] => {
      const label = placeLabel(place.displayName, place.formattedAddress);
      if (!place.location || !label) return [];
      const at = position(place.location);
      return [{ id: place.id ?? `text-${index}`, text: label, resolve: async () => at }];
    });
  };
}
