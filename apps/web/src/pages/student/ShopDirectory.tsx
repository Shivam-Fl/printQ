import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api.js';
import Topbar from '../../components/Topbar.js';

interface ShopRow {
  slug: string;
  name: string;
  campusName: string | null;
  address: string;
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
    <div className="page">
      <Topbar />
      <h1>Find a shop</h1>
      <input
        type="text"
        placeholder="Search by shop or campus name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {loading ? (
        <p className="dim">Loading…</p>
      ) : shops.length === 0 ? (
        <p className="dim">No shops found. Try a different search, or scan your shop's QR code.</p>
      ) : (
        <div className="stack" style={{ marginTop: 12 }}>
          {shops.map((s) => (
            <Link key={s.slug} to={`/s/${s.slug}`} className="card" style={{ display: 'block', color: 'inherit' }}>
              <strong>{s.name}</strong>
              <p className="dim" style={{ margin: '2px 0 0' }}>
                {s.address}
                {s.campusName ? ` · ${s.campusName}` : ''}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
