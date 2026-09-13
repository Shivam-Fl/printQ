import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, clearToken, getShopRole, getToken, setShopRole } from '../api.js';
import { resetSockets } from '../socket.js';

const LINKS = [
  { to: '/dashboard', label: 'Queue', end: true },
  { to: '/dashboard/setup', label: 'Setup' },
  { to: '/dashboard/insights', label: 'Insights', ownerOnly: true },
  { to: '/dashboard/earnings', label: 'Earnings', ownerOnly: true },
  { to: '/dashboard/history', label: 'History' },
  { to: '/dashboard/printers', label: 'Printers' },
  { to: '/dashboard/agents', label: 'Agents' },
  { to: '/dashboard/settings', label: 'Settings' },
];

/** Shared top nav for every shop screen. Also guards auth. */
export default function ShopNav() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [role, setRole] = useState<'owner' | 'staff' | null>(getShopRole());

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ shop: { name: string }; user: { role: 'owner' | 'staff' } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        setName(r.shop.name);
        setRole(r.user.role);
        setShopRole(r.user.role);
      })
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
        {LINKS.filter((link) => !link.ownerOnly || role === 'owner').map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {l.label}
          </NavLink>
        ))}
      </div>
      <button className="ghost small" onClick={signOut}>Sign out</button>
    </div>
  );
}
