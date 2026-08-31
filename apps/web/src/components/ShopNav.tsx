import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken } from '../api.js';
import { resetSockets } from '../socket.js';

const LINKS = [
  { to: '/dashboard', label: 'Queue', end: true },
  { to: '/dashboard/setup', label: 'Setup' },
  { to: '/dashboard/insights', label: 'Insights' },
  { to: '/dashboard/history', label: 'History' },
  { to: '/dashboard/printers', label: 'Printers' },
  { to: '/dashboard/agents', label: 'Agents' },
  { to: '/dashboard/settings', label: 'Settings' },
];

/** Shared top nav for every shop screen. Also guards auth. */
export default function ShopNav() {
  const navigate = useNavigate();
  const [name, setName] = useState('');

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ shop: { name: string } }>('/api/shop/me', { role: 'shop' })
      .then((r) => setName(r.shop.name))
      .catch(() => navigate('/dashboard/login'));
  }, [navigate]);

  function signOut() {
    clearToken('shop');
    resetSockets();
    navigate('/dashboard/login');
  }

  return (
    <div className="shopnav">
      <span className="brand">
        Print<em>Q</em>
        {name && <small>{name}</small>}
      </span>
      <div className="links">
        {LINKS.map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {l.label}
          </NavLink>
        ))}
      </div>
      <button className="ghost small" onClick={signOut}>Sign out</button>
    </div>
  );
}
