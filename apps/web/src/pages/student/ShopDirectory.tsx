import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import { createLatestRequest, isAbortError } from '../../lib/latestRequest.js';
import Topbar from '../../components/Topbar.js';
import { ErrorState, LoadingState } from '../../components/ResourceStates.js';
import { useResource } from '../../lib/useResource.js';

interface ShopRow {
  slug: string;
  name: string;
  campusName: string | null;
  address: string;
  open: boolean;
  distanceM?: number;
}

function isShopList(value: unknown): value is { shops: ShopRow[] } {
  const shops = (value as { shops?: unknown } | null)?.shops;
  return Array.isArray(shops) && shops.every((s) => s && typeof (s as ShopRow).slug === 'string' && typeof (s as ShopRow).name === 'string');
}

export default function ShopDirectory() {
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [nearbyShops, setNearbyShops] = useState<ShopRow[]>([]);
  const [locating, setLocating] = useState(false);
  const [nearby, setNearby] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');

  // One guard for text search and "near me": whichever started last wins, and
  // an older response (or an aborted one) never overwrites it.
  const latest = useRef(createLatestRequest());

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), q === '' ? 0 : 250);
    return () => clearTimeout(t);
  }, [q]);

  const list = useResource<{ shops: ShopRow[] }>(
    (signal) => api<{ shops: ShopRow[] }>(`/api/public/shops${debouncedQ ? `?q=${encodeURIComponent(debouncedQ)}` : ''}`, { signal }),
    [debouncedQ],
    { enabled: !nearby, validate: isShopList },
  );
  const searching = q !== debouncedQ;
  const loading = locating || (!nearby && (searching || (list.status !== 'ready' && list.status !== 'error')));
  const shops = nearby ? nearbyShops : (list.data?.shops ?? []);

  useEffect(() => {
    const guard = latest.current;
    return () => guard.cancel();
  }, []);

  function searchAgain(value: string) {
    latest.current.cancel(); // drop any in-flight "near me" lookup
    setLocating(false);
    setNearby(false);
    setLocationMessage('');
    setQ(value);
  }

  function findNearby() {
    if (!navigator.geolocation) {
      setLocationMessage('This browser cannot share a location. Search by shop or campus instead.');
      return;
    }
    setLocating(true);
    setLocationMessage('Checking nearby counters…');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const ticket = latest.current.begin();
        try {
          const result = await api<{ shops: ShopRow[] }>('/api/public/shops/nearby', {
            method: 'POST',
            signal: ticket.signal,
            body: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              maxDistanceM: 5_000,
            },
          });
          if (!ticket.isCurrent()) return; // the student typed a search meanwhile
          if (!isShopList(result)) throw new Error('bad response');
          setNearby(true);
          setQ('');
          setNearbyShops(result.shops);
          setLocationMessage('Nearby results use this one-time location only. PrintQs does not save it.');
        } catch (err) {
          if (isAbortError(err) || !ticket.isCurrent()) return;
          setLocationMessage('Could not find nearby counters. Search by shop or campus instead.');
        } finally {
          if (ticket.isCurrent()) setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocationMessage('Location access is off. Search by shop or campus instead.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  return (
    <main className="page">
      <Topbar />
      <div className="directory-heading"><span className="eyebrow-label">Print counters near you</span><h1>Find a shop</h1><p>Choose a connected shop now, or scan the QR displayed at your usual counter.</p></div>
      <div className="search-field"><span aria-hidden>⌕</span><input type="search" placeholder="Search shop, area or campus" value={q} onChange={(e) => searchAgain(e.target.value)} autoFocus /></div>
      <div className="row between" style={{ margin: '10px 0 18px' }}>
        <span className="dim">{locationMessage || 'Only live counters are listed.'}</span>
        <button className="ghost small" onClick={findNearby} disabled={locating}>⌖ Near me</button>
      </div>
      {loading ? (
        <LoadingState status={locating ? 'loading' : list.status} />
      ) : !nearby && list.status === 'error' ? (
        <ErrorState onRetry={list.retry} title="Could not load shops" />
      ) : shops.length === 0 ? (
        <div className="empty-state"><strong>No matching shops</strong><p>Try another shop or campus name, or scan the QR at your print counter.</p></div>
      ) : (
        <div className="directory-list">
          {shops.map((s) => (
            <Link key={s.slug} to={`/s/${s.slug}`} className="directory-card">
              <div className="store-avatar" aria-hidden>{s.name.slice(0, 2).toUpperCase()}</div>
              <div className="grow"><strong>{s.name}</strong><p>{s.address}{s.campusName ? ` · ${s.campusName}` : ''}{s.distanceM != null ? ` · ~${s.distanceM} m away` : ''}</p></div>
              <span className={`status-dot${s.open ? ' done' : ''}`}>{s.open ? 'Open' : 'Offline'}</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
