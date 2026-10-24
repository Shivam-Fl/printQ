import { useCallback, useEffect, useRef, useState } from 'react';
import ShopLocationPicker from './ShopLocationPicker.js';
import { addressIsReplaceable, MIN_QUERY_LENGTH, PINNED_LOCATION, reverseLabel, searchPlaces, type PlaceResult } from '../lib/geocode.js';

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
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<PlaceResult[]>([]);
  const lastAuto = useRef<string | null>(null);
  const addressRef = useRef(address);
  const reverseSeq = useRef(0);
  const detectedOnce = useRef(false);
  addressRef.current = address;
  const hasPin = latitude != null && longitude != null;

  const reverseTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    reverseSeq.current += 1;
  }, []);

  // Debounced (600 ms) so dragging the pin never burns the shared 30/min geocode budget.
  const fillAddress = useCallback((lat: number, lng: number) => {
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    const mine = ++reverseSeq.current;
    reverseTimer.current = window.setTimeout(() => { void runReverseRef.current(lat, lng, mine); }, 600);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runReverse = async (lat: number, lng: number, mine: number) => {
    const label = await reverseLabel(lat, lng);
    if (mine !== reverseSeq.current) return;
    if (!addressIsReplaceable(addressRef.current, lastAuto.current)) return;
    const next = label ?? PINNED_LOCATION;
    lastAuto.current = next;
    onAddress(next);
  };
  const runReverseRef = useRef(runReverse);
  runReverseRef.current = runReverse;

  const place = useCallback((lat: number, lng: number) => {
    onPin(lat, lng);
    fillAddress(lat, lng);
  }, [onPin, fillAddress]);

  const detect = useCallback(() => {
    if (!navigator.geolocation) {
      setMessage('This device cannot share its location. Search for your address or click the map.');
      return;
    }
    setBusy(true);
    setMessage('');
    const applyPosition = (position: GeolocationPosition, approximate: boolean) => {
      const lat = Number(position.coords.latitude.toFixed(6));
      const lng = Number(position.coords.longitude.toFixed(6));
      const accuracy = position.coords.accuracy;
      const zoom = accuracy <= 250 ? 17 : accuracy <= 2_000 ? 14 : accuracy <= 10_000 ? 12 : 10;
      setCenter({ latitude: lat, longitude: lng, zoom });
      if (accuracy > 100 || approximate) {
        setMessage(`Found your area (about ${Math.round(accuracy)} m accuracy). Click the map or drag the pin to the exact entrance.`);
      } else {
        setMessage(`Location found (about ${Math.round(accuracy)} m accuracy). Drag the pin if it is a little off.`);
      }
      // Even an approximate fix gives a starting pin to drag; the owner confirms it.
      place(lat, lng);
      setBusy(false);
    };
    const fallback = (denied: boolean) => {
      setMessage(denied
        ? 'Location access is off. Search your address below or click the map to drop the pin.'
        : 'Could not get a location. Search your address below or click the map to drop the pin.');
      setBusy(false);
    };
    navigator.geolocation.getCurrentPosition(
      (position) => applyPosition(position, false),
      (reason) => {
        if (reason.code === reason.PERMISSION_DENIED) { fallback(true); return; }
        navigator.geolocation.getCurrentPosition(
          (position) => applyPosition(position, true),
          () => fallback(false),
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  }, [place]);

  useEffect(() => {
    if (!autoDetect || detectedOnce.current || hasPin) return;
    detectedOnce.current = true;
    detect();
  }, [autoDetect, hasPin, detect]);

  async function search() {
    const text = query.trim();
    if (text.length < MIN_QUERY_LENGTH) {
      setMessage('Type at least 3 characters, for example a street, area or shop name.');
      return;
    }
    setSearching(true);
    setResults([]);
    try {
      const found = await searchPlaces(text, hasPin ? { latitude, longitude } : null);
      setResults(found);
      setMessage(found.length
        ? 'Choose the closest match, then drag the pin to the exact entrance.'
        : 'Nothing found. That is fine: click the map to drop the pin and type your address below.');
    } catch {
      setMessage('Address search is unavailable right now. Click the map to drop the pin and type your address.');
    } finally {
      setSearching(false);
    }
  }

  function choose(result: PlaceResult) {
    // A choice beats any lookup still in flight for an earlier pin.
    reverseSeq.current += 1;
    if (reverseTimer.current != null) window.clearTimeout(reverseTimer.current);
    setCenter({ latitude: result.latitude, longitude: result.longitude, zoom: 18 });
    setResults([]);
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
      </div>
      {message && <p className="dim" style={{ margin: 0 }} role="status">{message}</p>}
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
              <button type="button" onClick={() => choose(result)}>
                <span className="location-result-pin" aria-hidden>PIN</span>
                <span>{result.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <ShopLocationPicker latitude={latitude} longitude={longitude} center={center} onChange={place} />
      <span className="location-attribution">Address search and map data © OpenStreetMap contributors</span>
      {!hideAddress && (
        <div className="field">
          <label htmlFor="shop-address">Address students will see</label>
          <input id="shop-address" type="text" value={address} onChange={(event) => onAddress(event.target.value)} autoComplete="street-address" />
          <span className="field-help">Filled in from the pin. Edit it freely; “{PINNED_LOCATION}” is fine too.</span>
        </div>
      )}
    </div>
  );
}
