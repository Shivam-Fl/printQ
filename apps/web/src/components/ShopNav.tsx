import { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api, ApiError, getShopRole, getToken, setShopRole, signOutShop } from '../api.js';
import { resetSockets } from '../socket.js';
import FeeBanner from './FeeBanner.js';
import { shopLoginPath } from '../lib/locationFlow.js';

/** Only a real 401 means the session is over. A cold start (5xx) or a Wi-Fi blip must not sign the owner out. */
export function isSessionOver(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Wait before retrying /api/shop/me: 3 s, 6 s, 12 s, then every 15 s. */
export function shopMeRetryDelay(attempt: number): number {
  return Math.min(3_000 * 2 ** attempt, 15_000);
}

const LINKS = [
  { to: '/dashboard', label: 'Queue', end: true },
  { to: '/dashboard/setup', label: 'Setup' },
  { to: '/dashboard/insights', label: 'Insights', ownerOnly: true },
  { to: '/dashboard/earnings', label: 'Earnings', ownerOnly: true },
  { to: '/dashboard/history', label: 'History' },
  { to: '/dashboard/printers', label: 'Printers' },
  { to: '/dashboard/agents', label: 'Computers' },
  { to: '/dashboard/settings', label: 'Settings' },
];

/** Shared top nav for every shop screen. Also guards auth. */
export default function ShopNav() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [role, setRole] = useState<'owner' | 'staff' | null>(getShopRole());
  const [desktopStatus, setDesktopStatus] = useState<PrintQsDesktopStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(shopLoginPath());
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (attempt: number) => {
      api<{ shop: { name: string }; user: { role: 'owner' | 'staff' } }>('/api/shop/me', { role: 'shop' })
        .then((r) => {
          if (cancelled) return;
          setUnreachable(false);
          setName(r.shop.name);
          setRole(r.user.role);
          setShopRole(r.user.role);
        })
        .catch((err) => {
          if (cancelled) return;
          if (isSessionOver(err)) {
            navigate(shopLoginPath());
            return;
          }
          setUnreachable(true);
          timer = setTimeout(() => load(attempt + 1), shopMeRetryDelay(attempt));
        });
    };
    load(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [navigate]);

  useEffect(() => {
    const desktop = window.printqsDesktop;
    if (!desktop) return;
    let mounted = true;
    void desktop.load().then((result) => {
      if (mounted) setDesktopStatus(result.status);
    }).catch(() => undefined);
    const unsubscribe = desktop.onStatus((status) => {
      if (mounted) setDesktopStatus(status);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  async function signOut() {
    await signOutShop(); // revokes the session server-side, then clears the token
    resetSockets();
    navigate('/dashboard/login');
  }

  return (
    <>
    <div className="shopnav">
      <span className="brand">
        Print<em>Q</em>
        {name && <small title={name}>{name}</small>}
      </span>
      <div className="links">
        {LINKS.filter((link) => !link.ownerOnly || role === 'owner').map((l) => (
          <NavLink key={l.to} to={l.to} end={l.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            {l.label}
          </NavLink>
        ))}
      </div>
      {desktopStatus && (
        <NavLink to="/dashboard/agents" className={`desktop-nav-status ${desktopStatus.state === 'online' ? 'online' : ''}`}>
          <span />{desktopStatus.state === 'online' ? 'Printers ready' : 'Printer setup'}
        </NavLink>
      )}
      <NavLink to="/support" className="shopnav-help">Help &amp; policies</NavLink>
      <button className="ghost small" onClick={signOut}>Sign out</button>
    </div>
    {unreachable && <div className="shopnav-unreachable" role="status">Can’t reach PrintQs, retrying…</div>}
    <FeeBanner />
    </>
  );
}
