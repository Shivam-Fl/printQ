import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import Topbar from '../../components/Topbar.js';

interface ShopRow {
  slug: string;
  name: string;
  campusName: string | null;
  address: string;
  open: boolean;
  distanceM?: number;
}

export default function ShopDirectory() {
  const [q, setQ] = useState('');
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [nearby, setNearby] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');

  useEffect(() => {
    if (nearby) return;
    setLoading(true);
    const t = setTimeout(() => {
      api<{ shops: ShopRow[] }>(`/api/public/shops${q ? `?q=${encodeURIComponent(q)}` : ''}`)
        .then((r) => setShops(r.shops))
        .catch(() => setShops([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q, nearby]);

  function searchAgain(value: string) {
    setNearby(false);
    setLocationMessage('');
    setQ(value);
  }

  function findNearby() {
    if (!navigator.geolocation) {
      setLocationMessage('This browser cannot share a location. Search by shop or campus instead.');
      return;
    }
    setLoading(true);
    setLocationMessage('Checking nearby counters…');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const result = await api<{ shops: ShopRow[] }>('/api/public/shops/nearby', {
            method: 'POST',
            body: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              maxDistanceM: 5_000,
            },
          });
          setNearby(true);
          setQ('');
          setShops(result.shops);
          setLocationMessage('Nearby results use this one-time location only. PrintQs does not save it.');
        } catch {
          setLocationMessage('Could not find nearby counters. Search by shop or campus instead.');
        } finally {
          setLoading(false);
        }
      },
      () => {
        setLoading(false);
        setLocationMessage('Location access is off. Search by shop or campus instead.');
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  return (
    <main className="page">
      <Topbar />
      <div className="directory-heading"><span className="eyebrow-label">Campus print counters</span><h1>Find a shop</h1><p>Choose a connected shop now, or scan the QR displayed at your usual counter.</p></div>
      <div className="search-field"><span aria-hidden>⌕</span><input type="search" placeholder="Search shop or campus" value={q} onChange={(e) => searchAgain(e.target.value)} autoFocus /></div>
      <div className="row between" style={{ margin: '10px 0 18px' }}>
        <span className="dim">{locationMessage || 'Only verified campus counters are listed.'}</span>
        <button className="ghost small" onClick={findNearby} disabled={loading}>⌖ Near me</button>
      </div>
      {loading ? (
        <p className="dim">Loading…</p>
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
