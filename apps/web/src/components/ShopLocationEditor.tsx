import { useCallback, useEffect, useRef, useState } from 'react';
import ShopLocationPicker from './ShopLocationPicker.js';
import { useGoogleMaps } from './GoogleLocationMap.js';
import {
  autoSearchQuery, desktopLocationTip, deviceFixMessage, isPreciseFix, locationFailureLead, searchMessage, SEARCH_FAILED_MESSAGE,
} from '../lib/locationFlow.js';
import { addressIsReplaceable, createPlaceSearch, MIN_QUERY_LENGTH, PINNED_LOCATION, reverseLabel, type PlaceResult, type SearchHit } from '../lib/geocode.js';

interface Props {
  latitude: number | null;
  longitude: number | null;
  address: string;
  onPin: (latitude: number, longitude: number) => void;
  onAddress: (address: string) => void;
  /** Ask for the device location once on mount (first-time setup). */
  autoDetect?: boolean;
  /** Hide the address box when the host form already has one. */
  hideAddress?: boolean;
}

/**
 * Pin the shop anywhere in the world: device location, address search (explicit
 * button, never per keystroke), draggable pin, and a reverse lookup that fills the
 * address. Search failing or finding nothing never blocks: pin + typed address is enough.
 */
export default function ShopLocationEditor({ latitude, longitude, address, onPin, onAddress, autoDetect, hideAddress }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [center, setCenter] = useState<{ latitude: number; longitude: number; zoom?: number } | null>(null);
  /** A rough device fix (> 100 m): shown as a circle, never pinned by itself. */
  const [area, setArea] = useState<{ latitude: number; longitude: number; radius: number } | null>(null);
  /** The device gave no location; inside the desktop app we also point at the PC's Chrome. */
  const [locationFailed, setLocationFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<SearchHit[]>([]);
  /** Google Places when a browser key is set, else the API search; keeps one Google session per editor. */
  const [findPlaces] = useState(createPlaceSearch);
  const google = useGoogleMaps();
  /** What the map calls the current pin; shown even when the owner typed a different address. */
  const [pinLabel, setPinLabel] = useState<string | null>(null);
  const lastAuto = useRef<string | null>(null);
  const autoSearched = useRef(false);
  const addressRef = useRef(address);
  const reverseSeq = useRef(0);
  const detectedOnce = useRef(false);
  const detectSeq = useRef(0);
  addressRef.current = address;
  const hasPin = latitude != null && longitude != null;

  const reverseTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    reverseSeq.current += 1;
  }, []);

  const runReverse = async (lat: number, lng: number, mine: number) => {
    const label = await reverseLabel(lat, lng);
    if (mine !== reverseSeq.current) return;
    setPinLabel(label);
    if (!addressIsReplaceable(addressRef.current, lastAuto.current)) return;
    const next = label ?? PINNED_LOCATION;
    lastAuto.current = next;
    onAddress(next);
  };
  const runReverseRef = useRef(runReverse);
  runReverseRef.current = runReverse;

  // Debounced (600 ms) so dragging the pin never burns the shared 30/min geocode budget.
  const fillAddress = useCallback((lat: number, lng: number) => {
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    const mine = ++reverseSeq.current;
    setPinLabel(null);
    reverseTimer.current = window.setTimeout(() => { void runReverseRef.current(lat, lng, mine); }, 600);
  }, []);

  const place = useCallback((lat: number, lng: number) => {
    onPin(lat, lng);
    fillAddress(lat, lng);
  }, [onPin, fillAddress]);

  /** Location is off: search once for the address typed at sign-up, so the owner only picks a match. */
  const autoSearchRef = useRef<(intro: string) => boolean>(() => false);
  autoSearchRef.current = (intro: string) => {
    const text = autoSearchQuery(addressRef.current);
    if (!autoDetect || hasPin || autoSearched.current || !text) return false;
    autoSearched.current = true;
    setQuery(text);
    void runSearch(text, intro);
    return true;
  };

  const detect = useCallback(() => {
    setArea(null);
    if (!navigator.geolocation) {
      setLocationFailed(true);
      if (autoSearchRef.current('This device cannot share its location, so we searched for your address. ')) return;
      setMessage('This device cannot share its location. Search for your address or click the map.');
      return;
    }
    setBusy(true);
    setMessage('');
    setLocationFailed(false);
    const mine = ++detectSeq.current;
    const applyPosition = (position: GeolocationPosition) => {
      if (mine !== detectSeq.current) return; // cancelled, or the owner already placed the pin
      const lat = Number(position.coords.latitude.toFixed(6));
      const lng = Number(position.coords.longitude.toFixed(6));
      const accuracy = position.coords.accuracy;
      setBusy(false);
      setMessage(deviceFixMessage(accuracy));
      if (isPreciseFix(accuracy)) {
        setCenter({ latitude: lat, longitude: lng, zoom: 17 });
        place(lat, lng);
        return;
      }
      // Too rough to pin by itself (students check in near the saved pin): show the area and let the
      // owner tap the entrance. Save stays off until they do, because there is no pin yet.
      setArea({ latitude: lat, longitude: lng, radius: Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 1_000 });
    };
    const fallback = (denied: boolean) => {
      if (mine !== detectSeq.current) return;
      setBusy(false);
      setLocationFailed(true);
      const lead = locationFailureLead(denied);
      if (autoSearchRef.current(`${lead}, so we searched for the address you typed. `)) return;
      setMessage(`${lead}. Search your address below or click the map to drop the pin.`);
    };
    navigator.geolocation.getCurrentPosition(
      applyPosition,
      (reason) => {
        if (mine !== detectSeq.current) return;
        if (reason.code === reason.PERMISSION_DENIED) { fallback(true); return; }
        navigator.geolocation.getCurrentPosition(
          applyPosition,
          () => fallback(false),
          { enableHighAccuracy: false, timeout: 6_000, maximumAge: 300_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 8_000, maximumAge: 10_000 },
    );
  }, [place]);

  function cancelDetect() {
    detectSeq.current += 1;
    setBusy(false);
    setMessage('Location lookup cancelled. Search your address below or click the map to drop the pin.');
  }

  /** The owner's own pin beats any device lookup still running: a late fix must never move it. */
  function stopDetect() {
    detectSeq.current += 1;
    setBusy(false);
    setArea(null);
    setLocationFailed(false);
  }

  /** Map click or pin drag. */
  function placeByHand(lat: number, lng: number) {
    if (busy || area || locationFailed) setMessage('Pin placed. You can still drag it to your exact shop entrance.');
    stopDetect();
    place(lat, lng);
  }

  useEffect(() => {
    if (!autoDetect || detectedOnce.current || hasPin) return;
    detectedOnce.current = true;
    detect();
  }, [autoDetect, hasPin, detect]);

  // First-time setup that opens with a pin (handed over from register): look it up once so the
  // owner sees what the map calls that spot and an empty address gets filled.
  useEffect(() => {
    if (autoDetect && latitude != null && longitude != null) fillAddress(latitude, longitude);
    // Mount only: later pins are looked up where they are placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** `intro` marks the one automatic search: its message explains why, and the map moves to the best match. */
  async function runSearch(text: string, intro = '') {
    setSearching(true);
    setResults([]);
    try {
      // Bias towards the pin, or towards the rough area the device found, so nearby matches come first.
      const found = await findPlaces(text, hasPin ? { latitude, longitude } : area);
      setResults(found);
      setMessage(intro + searchMessage(found));
      if (intro && found[0]) {
        const mine = detectSeq.current;
        const best = await found[0].resolve().catch(() => null);
        if (best && mine === detectSeq.current) setCenter({ latitude: best.latitude, longitude: best.longitude, zoom: 16 });
      }
    } catch {
      setMessage(intro + SEARCH_FAILED_MESSAGE);
    } finally {
      setSearching(false);
    }
  }

  async function search() {
    const text = query.trim();
    if (text.length < MIN_QUERY_LENGTH) {
      setMessage('Type at least 3 characters, for example a street, area or shop name.');
      return;
    }
    await runSearch(text);
  }

  async function choose(hit: SearchHit) {
    // A choice beats any device fix still coming.
    stopDetect();
    const mine = detectSeq.current;
    let result: PlaceResult | null = null;
    try {
      result = await hit.resolve(); // Google matches fetch their coordinates only now
    } catch { /* handled below */ }
    if (mine !== detectSeq.current) return; // the owner pinned by hand or chose again meanwhile
    if (!result) {
      setMessage('Could not open that match. Choose another, or click the map to drop the pin.');
      return;
    }
    // ...and any lookup still in flight for an earlier pin.
    reverseSeq.current += 1;
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    setCenter({ latitude: result.latitude, longitude: result.longitude, zoom: 18 });
    setResults([]);
    setPinLabel(result.label);
    onPin(result.latitude, result.longitude);
    if (addressIsReplaceable(addressRef.current, lastAuto.current)) {
      lastAuto.current = result.label;
      onAddress(result.label);
    }
    setMessage(`Pinned near ${result.label}. Drag the pin to the exact entrance.`);
  }

  return (
    <div className="location-editor">
      <div className="location-actions">
        <button type="button" className="secondary" disabled={busy} onClick={detect}>
          {busy ? 'Finding your location…' : 'Use my location'}
        </button>
        {busy && <button type="button" className="ghost" onClick={cancelDetect}>Cancel</button>}
      </div>
      {message && <p className="dim" style={{ margin: 0 }} role="status">{message}</p>}
      {locationFailed && typeof window !== 'undefined' && window.printqsDesktop && (
        <p className="dim" style={{ margin: 0 }}>{desktopLocationTip(window.location.host)}</p>
      )}
      <form className="location-search" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <div className="field grow">
          <label htmlFor="location-search">Search an address <span className="optional-label">optional</span></label>
          <input
            id="location-search"
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Street, area, shop name or city"
            autoComplete="off"
          />
        </div>
        <button type="submit" disabled={searching || query.trim().length < MIN_QUERY_LENGTH}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {results.length > 0 && (
        <ul className="location-search-results" aria-label="Address matches" style={{ listStyle: 'none', margin: 0 }}>
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => { void choose(result); }}>
                <span className="location-result-pin" aria-hidden>PIN</span>
                <span>{result.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ShopLocationPicker latitude={latitude} longitude={longitude} center={center} area={area} onChange={placeByHand} pinLabel={pinLabel} />
      {!google && <span className="location-attribution">Address search and map data © OpenStreetMap contributors</span>}
      {!hideAddress && (
        <div className="field">
          <label htmlFor="shop-address">Address students will see</label>
          <input id="shop-address" type="text" value={address} onChange={(event) => onAddress(event.target.value)} autoComplete="street-address" />
          <span className="field-help">
            {!hasPin
              ? 'Shop number, road and area, so students can find you.'
              : lastAuto.current !== null && address.trim() === lastAuto.current
                ? 'Filled in from the pin. Add your shop number or a landmark so students can find you.'
                : `Edit it freely; “${PINNED_LOCATION}” is fine too.`}
          </span>
        </div>
      )}
    </div>
  );
}
