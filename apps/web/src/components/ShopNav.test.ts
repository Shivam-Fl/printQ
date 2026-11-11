import { describe, expect, it } from 'vitest';
import { ApiError } from '../api.js';
import { isActiveItem, isSessionOver, navItems, shopMeRetryDelay } from './ShopNav.js';
import { shopTabs } from './ShopTabs.js';

describe('ShopNav session guard (M8)', () => {
  it('signs out only on a real 401', () => {
    expect(isSessionOver(new ApiError(401, 'Unauthorized'))).toBe(true);
    expect(isSessionOver(new ApiError(503, 'busy'))).toBe(false);
    expect(isSessionOver(new ApiError(0, 'offline'))).toBe(false);
    expect(isSessionOver(new TypeError('Failed to fetch'))).toBe(false);
  });

  it('retries with a capped backoff', () => {
    expect([0, 1, 2, 3, 10].map(shopMeRetryDelay)).toEqual([3_000, 6_000, 12_000, 15_000, 15_000]);
  });
});

describe('shop navigation: four destinations at most', () => {
  it('owners get Counter, History, Earnings and Shop', () => {
    const items = navItems('owner', true);
    expect(items.map((i) => i.label)).toEqual(['Counter', 'History', 'Earnings', 'Shop']);
    expect(items.length).toBeLessThanOrEqual(4);
  });
  it('staff never see Earnings', () => {
    expect(navItems('staff', true).map((i) => i.label)).toEqual(['Counter', 'History', 'Shop']);
  });
  it('Shop opens the setup checklist until the shop has gone live, then its first tab', () => {
    expect(navItems('owner', false).find((i) => i.key === 'shop')?.to).toBe('/dashboard/setup');
    expect(navItems('owner', true).find((i) => i.key === 'shop')?.to).toBe('/dashboard/prices');
    expect(navItems('staff', true).find((i) => i.key === 'shop')?.to).toBe('/dashboard/printers');
  });
  it('marks the right item active, including Shop sub-pages and the old Insights link', () => {
    const items = navItems('owner', true);
    const active = (path: string) => items.filter((i) => isActiveItem(i, path)).map((i) => i.key);
    expect(active('/dashboard')).toEqual(['counter']);
    expect(active('/dashboard/agents')).toEqual(['shop']);
    expect(active('/dashboard/settings')).toEqual(['shop']);
    expect(active('/dashboard/insights')).toEqual(['earnings']);
    expect(active('/dashboard/earnings/receipt/abc')).toEqual(['earnings']);
  });
});

describe('Shop area tabs', () => {
  it('shows Setup only until the shop is live', () => {
    expect(shopTabs('owner', false).map((t) => t.label)).toEqual(['Setup', 'Prices', 'Printers', 'Counter PC', 'Settings']);
    expect(shopTabs('owner', true).map((t) => t.label)).toEqual(['Prices', 'Printers', 'Counter PC', 'Settings']);
  });
  it('gives staff the printer pages only', () => {
    expect(shopTabs('staff', true).map((t) => t.label)).toEqual(['Printers', 'Counter PC']);
  });
});
