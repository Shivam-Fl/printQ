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
}

export default function ShopDirectory() {
  const [q, setQ] = useState('');
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const t = setTimeout(() => {
      api<{ shops: ShopRow[] }>(`/api/public/shops${q ? `?q=${encodeURIComponent(q)}` : ''}`)
        .then((r) => setShops(r.shops))
        .catch(() => setShops([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <main className="page">
      <Topbar />
      <div className="directory-heading"><span className="eyebrow-label">Campus print counters</span><h1>Find a shop</h1><p>Choose a connected shop now, or scan the QR displayed at your usual counter.</p></div>
      <div className="search-field"><span aria-hidden>⌕</span><input type="search" placeholder="Search shop or campus" value={q} onChange={(e) => setQ(e.target.value)} autoFocus /></div>
      {loading ? (
        <p className="dim">Loading…</p>
      ) : shops.length === 0 ? (
        <div className="empty-state"><strong>No matching shops</strong><p>Try another shop or campus name, or scan the QR at your print counter.</p></div>
      ) : (
        <div className="directory-list">
          {shops.map((s) => (
            <Link key={s.slug} to={`/s/${s.slug}`} className="directory-card">
              <div className="store-avatar" aria-hidden>{s.name.slice(0, 2).toUpperCase()}</div>
              <div className="grow"><strong>{s.name}</strong><p>{s.address}{s.campusName ? ` · ${s.campusName}` : ''}</p></div>
              <span className={`status-dot${s.open ? ' done' : ''}`}>{s.open ? 'Open' : 'Offline'}</span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
