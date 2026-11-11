import { describe, expect, it, vi } from 'vitest';
import { hasGoneLive, shopStatus, statusChip, type ShopSetupStatus } from './shopStatus.js';

const setup = (over: Partial<ShopSetupStatus> = {}): ShopSetupStatus => ({
  locationReady: true,
  pricingReady: true,
  printerReady: true,
  agentReady: true,
  ready: true,
  acceptingOrders: true,
  counts: { linkedPrinters: 1, onlinePrinters: 1, agents: 1, onlineAgents: 1, detectedPrinters: 0, simulatorPrinters: 0 },
  visibility: { state: 'live', reason: null },
  ...over,
});

describe('nav status chip', () => {
  it('a live shop says Live', () => {
    expect(statusChip(setup())).toMatchObject({ label: 'Live', tone: 'ok' });
  });
  it('owner-paused, practice-only and PC-offline shops say so', () => {
    expect(statusChip(setup({ acceptingOrders: false }))).toMatchObject({ label: 'New orders paused', tone: 'warn', to: '/dashboard' });
    expect(statusChip(setup({ counts: { linkedPrinters: 0, onlinePrinters: 0, agents: 1, onlineAgents: 1, simulatorPrinters: 1 } })))
      .toMatchObject({ label: 'Practice mode', tone: 'warn' });
    expect(statusChip(setup({ visibility: { state: 'live_pc_offline', reason: null } }))).toMatchObject({ label: 'Counter PC offline', tone: 'danger', to: '/dashboard/agents' });
  });
  it('a shop hidden by PrintQs carries the reason', () => {
    expect(statusChip(setup({ visibility: { state: 'hidden_by_admin', reason: 'Fake listing' } }))).toMatchObject({ label: 'Paused by PrintQs', detail: 'Reason: Fake listing' });
  });
  it('a shop in setup counts the same steps as the checklist', () => {
    const s = setup({ ready: false, agentReady: false, printerReady: false, visibility: { state: 'not_ready', reason: null }, counts: { linkedPrinters: 0, onlinePrinters: 0, agents: 0, onlineAgents: 0 } });
    expect(statusChip(s)).toMatchObject({ label: 'Setup 2 of 3', tone: 'warn', to: '/dashboard/setup' });
    expect(hasGoneLive(s)).toBe(false);
    expect(hasGoneLive(setup())).toBe(true);
    expect(statusChip(null)).toBeNull();
  });
});

describe('shared status store', () => {
  it('shares one request between callers and skips fresh data', async () => {
    shopStatus.reset();
    const fetcher = vi.fn(async () => setup());
    await Promise.all([shopStatus.ensure(fetcher), shopStatus.ensure(fetcher)]);
    await shopStatus.ensure(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(shopStatus.get()?.ready).toBe(true);
  });
  it('tells subscribers about new snapshots and resets on sign-out', () => {
    const seen: (ShopSetupStatus | null)[] = [];
    const off = shopStatus.subscribe((s) => seen.push(s));
    shopStatus.set(setup({ acceptingOrders: false }));
    shopStatus.reset();
    off();
    expect(seen.map((s) => s?.acceptingOrders ?? null)).toEqual([false, null]);
  });
});
