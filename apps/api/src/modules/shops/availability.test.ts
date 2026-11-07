import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const agentFindMany = vi.hoisted(() => vi.fn());
const printerUpdateMany = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma.js', () => ({
  prisma: { agent: { findMany: agentFindMany }, printer: { updateMany: printerUpdateMany }, $disconnect: vi.fn() },
}));
vi.mock('../../providers/notification/index.js', () => ({ notifyStudent: vi.fn() }));

import { env } from '../../config/env.js';
import { isShopOperationalFrom, markUnreachablePrintersOffline, restorePrintersReachedAgain } from './availability.js';

describe('isShopOperationalFrom and the PrintQ Simulator (PSO-1)', () => {
  const saved = { NODE_ENV: env.NODE_ENV, ALLOW: env.ALLOW_SIMULATED_PRINT_COMPLETION };
  afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    env.ALLOW_SIMULATED_PRINT_COMPLETION = saved.ALLOW;
  });
  const shop = (osPrinterName: string) => ({
    acceptingOrders: true,
    feeBlockedAt: null,
    latitude: 19.19,
    longitude: 72.97,
    agents: [{ connectedPrinterIds: ['p1'] }],
    printers: [{ id: 'p1', status: 'online', osPrinterName }],
  });

  it('a simulator-only shop takes no orders in production', () => {
    env.NODE_ENV = 'production';
    env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
    expect(isShopOperationalFrom(shop('PrintQ Simulator'))).toBe(false);
    expect(isShopOperationalFrom(shop('HP LaserJet'))).toBe(true);
  });

  it('the simulator still takes orders in development', () => {
    env.NODE_ENV = 'development';
    expect(isShopOperationalFrom(shop('PrintQ Simulator'))).toBe(true);
  });
});

describe('printers follow their PC when it is removed and re-added', () => {
  beforeEach(() => {
    agentFindMany.mockReset();
    printerUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it('switches offline only the printers no remaining PC is connected to', async () => {
    agentFindMany.mockResolvedValue([{ connectedPrinterIds: ['p2'] }]); // another PC (maybe off for the night) still has p2
    expect(await markUnreachablePrintersOffline('s1', ['p1', 'p2'])).toBe(1);
    expect(agentFindMany).toHaveBeenCalledWith({ where: { shopId: 's1' }, select: { connectedPrinterIds: true } });
    expect(printerUpdateMany).toHaveBeenCalledWith({
      where: { shopId: 's1', id: { in: ['p1'] }, status: 'online' },
      data: { status: 'offline' },
    });
  });

  it('does nothing when the removed PC had no printers, or every printer is still reached', async () => {
    expect(await markUnreachablePrintersOffline('s1', [])).toBe(0);
    agentFindMany.mockResolvedValue([{ connectedPrinterIds: ['p1'] }]);
    expect(await markUnreachablePrintersOffline('s1', ['p1'])).toBe(0);
    expect(printerUpdateMany).not.toHaveBeenCalled();
  });

  it('switches a printer back online when a PC links it and no other PC had it', async () => {
    agentFindMany.mockResolvedValue([{ connectedPrinterIds: ['p2'] }]);
    await restorePrintersReachedAgain('s1', 'a-new', ['p1', 'p2']);
    expect(agentFindMany).toHaveBeenCalledWith({ where: { shopId: 's1', id: { not: 'a-new' } }, select: { connectedPrinterIds: true } });
    // p2 is reached by another PC, so an 'offline' there is a staff choice and is kept; 'jammed' is never touched
    expect(printerUpdateMany).toHaveBeenCalledWith({
      where: { shopId: 's1', id: { in: ['p1'] }, status: 'offline' },
      data: { status: 'online' },
    });
  });

  it('skips the lookup entirely when nothing new was linked', async () => {
    await restorePrintersReachedAgain('s1', 'a1', []);
    expect(agentFindMany).not.toHaveBeenCalled();
    expect(printerUpdateMany).not.toHaveBeenCalled();
  });
});
