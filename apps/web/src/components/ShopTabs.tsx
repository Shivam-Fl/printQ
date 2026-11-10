import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { getShopRole } from '../api.js';
import { hasGoneLive, shopStatus, type ShopSetupStatus } from '../lib/shopStatus.js';

export interface ShopTab {
  to: string;
  label: string;
}

/**
 * Sections of the "Shop" area. Setup is a tab only until the shop has gone live
 * (after that the nav's status chip leads back to it when something breaks).
 * Staff can look at printers and the counter PC; prices and settings are owner-only.
 */
export function shopTabs(role: 'owner' | 'staff' | null, live: boolean): ShopTab[] {
  if (role === 'staff') {
    return [
      { to: '/dashboard/printers', label: 'Printers' },
      { to: '/dashboard/agents', label: 'Counter PC' },
    ];
  }
  return [
    ...(live ? [] : [{ to: '/dashboard/setup', label: 'Setup' }]),
    { to: '/dashboard/prices', label: 'Prices' },
    { to: '/dashboard/printers', label: 'Printers' },
    { to: '/dashboard/agents', label: 'Counter PC' },
    { to: '/dashboard/settings', label: 'Settings' },
  ];
}

/** Tab strip under the page title on every Shop page. */
export default function ShopTabs() {
  const { pathname } = useLocation();
  const [setup, setSetup] = useState<ShopSetupStatus | null>(shopStatus.get());
  useEffect(() => shopStatus.subscribe(setSetup), []);
  const tabs = shopTabs(getShopRole(), hasGoneLive(setup));
  // the setup page itself always shows its tab (also after go-live, when opened from the status chip)
  const visible = pathname.startsWith('/dashboard/setup') && !tabs.some((t) => t.to === '/dashboard/setup')
    ? [{ to: '/dashboard/setup', label: 'Setup' }, ...tabs]
    : tabs;
  return (
    <nav className="tabs" aria-label="Shop sections">
      {visible.map((tab) => {
        const active = pathname === tab.to || pathname.startsWith(`${tab.to}/`);
        return (
          <Link key={tab.to} to={tab.to} className={active ? 'active' : undefined} aria-current={active ? 'page' : undefined}>
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
