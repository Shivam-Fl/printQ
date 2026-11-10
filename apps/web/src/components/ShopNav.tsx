import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiError, getShopRole, getToken, setShopRole, signOutShop } from '../api.js';
import { resetSockets } from '../socket.js';
import FeeBanner from './FeeBanner.js';
import { shopLoginPath } from '../lib/locationFlow.js';
import { clearShopSessionNotice, noteShopSessionEnded } from '../lib/shopSessionNotice.js';
import { hasGoneLive, shopStatus, statusChip, type ShopSetupStatus } from '../lib/shopStatus.js';
import { IconLogout, IconStore } from './Icons.js';
import { IconChevronDown, IconCounter, IconHelp, IconHistory, IconRupee } from './ShopIcons.js';
import '../shop.css';

/** Only a real 401 means the session is over. A cold start (5xx) or a Wi-Fi blip must not sign the owner out. */
export function isSessionOver(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/** Wait before retrying /api/shop/me: 3 s, 6 s, 12 s, then every 15 s. */
export function shopMeRetryDelay(attempt: number): number {
  return Math.min(3_000 * 2 ** attempt, 15_000);
}

/** Pages that live under "Shop" (setup, prices, printers, counter PC, settings). */
export const SHOP_AREA_PATHS = ['/dashboard/setup', '/dashboard/prices', '/dashboard/printers', '/dashboard/agents', '/dashboard/settings'];
const EARNINGS_PATHS = ['/dashboard/earnings', '/dashboard/insights'];

export interface ShopNavItem {
  key: 'counter' | 'history' | 'earnings' | 'shop';
  to: string;
  label: string;
  /** Path prefixes that make this item the current one. */
  match: string[];
  exact?: boolean;
}

/**
 * Four destinations at most. Staff never see Earnings; "Shop" opens the setup
 * checklist until the shop has gone live, then the printers (the page staff need
 * when something breaks).
 */
export function navItems(role: 'owner' | 'staff' | null, live: boolean): ShopNavItem[] {
  const items: ShopNavItem[] = [
    { key: 'counter', to: '/dashboard', label: 'Counter', match: ['/dashboard'], exact: true },
    { key: 'history', to: '/dashboard/history', label: 'History', match: ['/dashboard/history'] },
  ];
  if (role === 'owner') items.push({ key: 'earnings', to: '/dashboard/earnings', label: 'Earnings', match: EARNINGS_PATHS });
  items.push({ key: 'shop', to: role === 'owner' && !live ? '/dashboard/setup' : '/dashboard/printers', label: 'Shop', match: SHOP_AREA_PATHS });
  return items;
}

export function isActiveItem(item: ShopNavItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (item.exact) return path === item.to;
  return item.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

const ICONS: Record<ShopNavItem['key'], ComponentType<{ className?: string }>> = {
  counter: IconCounter,
  history: IconHistory,
  earnings: IconRupee,
  shop: IconStore,
};

function fetchSetup(): Promise<ShopSetupStatus> {
  return api<{ setup: ShopSetupStatus }>('/api/shop/setup-status', { role: 'shop' }).then((r) => r.setup);
}

/** Shared navigation for every shop screen. Also guards auth. */
export default function ShopNav() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [name, setName] = useState('');
  const [role, setRole] = useState<'owner' | 'staff' | null>(getShopRole());
  const [setup, setSetup] = useState<ShopSetupStatus | null>(shopStatus.get());
  const [desktopStatus, setDesktopStatus] = useState<PrintQsDesktopStatus | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const signedOutHere = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const token = getToken('shop');
    if (!token) {
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
            noteShopSessionEnded(token); // revoked elsewhere: the login page says why (once)
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
      // Any page's API call that got a 401 cleared the token before sending us to login.
      if (!signedOutHere.current && !getToken('shop')) noteShopSessionEnded(token);
    };
  }, [navigate]);

  // the status chip: share whatever the page already loaded, refresh every 30 s
  useEffect(() => {
    if (!getToken('shop')) return;
    const unsubscribe = shopStatus.subscribe(setSetup);
    void shopStatus.ensure(fetchSetup);
    const poll = setInterval(() => void shopStatus.ensure(fetchSetup), 30_000);
    return () => {
      unsubscribe();
      clearInterval(poll);
    };
  }, []);

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

  // the account menu closes on route change, outside click and Escape
  useEffect(() => setMenuOpen(false), [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuButton.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  async function signOut() {
    signedOutHere.current = true;
    clearShopSessionNotice();
    await signOutShop(); // revokes the session server-side, then clears the token
    resetSockets();
    shopStatus.reset();
    navigate('/dashboard/login');
  }

  const items = navItems(role, hasGoneLive(setup));
  const chip = statusChip(setup);
  const pcProblem = desktopStatus && desktopStatus.state !== 'online';

  const links = (className: string, withIcons: boolean) => (
    <ul className={className}>
      {items.map((item) => {
        const Icon = ICONS[item.key];
        const active = isActiveItem(item, pathname);
        return (
          <li key={item.key}>
            <Link to={item.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
              {withIcons && <Icon />}
              <span>{item.label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );

  return (
    <>
      <header className="shopnav">
        <Link to="/dashboard" className="brand" aria-label="PrintQs counter">
          {/* one span so it is read as "PrintQs", not "Print Q s" */}
          <span>Print<em>Q</em>s</span>
        </Link>
        <nav className="shopnav-main" aria-label="Main">
          {links('shopnav-links', false)}
        </nav>
        <div className="shopnav-side">
          {pcProblem && (
            <NavLink to="/dashboard/agents" className="status-chip danger" title={desktopStatus.detail}>
              <span className="dot" aria-hidden />This PC {desktopStatus.state === 'connecting' ? 'connecting' : 'offline'}
            </NavLink>
          )}
          {chip && (
            <NavLink to={chip.to} className={`status-chip ${chip.tone}`} title={chip.detail}>
              <span className="dot" aria-hidden />{chip.label}
              <span className="sr-only">. {chip.detail}</span>
            </NavLink>
          )}
          <div className="account" ref={menuRef}>
            <button
              ref={menuButton}
              type="button"
              className="account-button"
              aria-expanded={menuOpen}
              aria-controls="shop-account-menu"
              onClick={() => setMenuOpen((open) => !open)}
              title={name || undefined}
            >
              <span className="account-name">{name || 'Your shop'}</span>
              <IconChevronDown />
            </button>
            {menuOpen && (
              <div id="shop-account-menu" className="account-menu" role="group" aria-label="Account">
                <div className="account-who">
                  <strong>{name || 'Your shop'}</strong>
                  <span>{role === 'staff' ? 'Counter staff' : 'Owner'}</span>
                </div>
                <Link to="/support" className="account-item"><IconHelp />Help &amp; policies</Link>
                <button type="button" className="account-item" onClick={() => void signOut()}><IconLogout />Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      {unreachable && <div className="shopnav-unreachable" role="status">Can’t reach PrintQs. Retrying…</div>}
      <FeeBanner />
      <nav className="shop-tabbar" aria-label="Main">
        {links('shop-tabbar-links', true)}
      </nav>
    </>
  );
}
