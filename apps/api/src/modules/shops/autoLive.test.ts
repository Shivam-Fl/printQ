import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma.js', () => ({ prisma: { shop: { findUnique, updateMany }, $disconnect: vi.fn() } }));
vi.mock('../public/cache.js', () => ({ invalidatePublicCaches: vi.fn() }));

import { env } from '../../config/env.js';
import { publishIfReady } from './autoLive.js';

const menu = { papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }], bindings: [], duplexEnabled: false };
const readyShop = (over: Record<string, unknown> = {}) => ({
  id: 's1', autoLive: true, verificationStatus: 'draft', publishedAt: null,
  latitude: 51.5, longitude: -0.12, printOptions: menu, campusId: null,
  printers: [{ id: 'p1', osPrinterName: 'HP', status: 'online' }],
  agents: [{ status: 'online', connectedPrinterIds: ['p1'] }],
  ...over,
});

describe('publishIfReady (new shops go live automatically)', () => {
  beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 1 });
  });

  it('publishes a new shop with no campus once location, menu, linked printer and online agent exist', async () => {
    findUnique.mockResolvedValue(readyShop());
    expect(await publishIfReady('s1')).toBe(true);
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ verificationStatus: { in: ['draft', 'submitted'] }, publishedAt: null, autoLive: true }),
      data: expect.objectContaining({ verificationStatus: 'verified', publishedAt: expect.any(Date) }),
    }));
  });

  it('also publishes a shop stuck in submitted (older client)', async () => {
    findUnique.mockResolvedValue(readyShop({ verificationStatus: 'submitted' }));
    expect(await publishIfReady('s1')).toBe(true);
  });

  it.each([
    ['no location', { latitude: null }],
    ['agent offline', { agents: [{ status: 'offline', connectedPrinterIds: ['p1'] }] }],
    ['printer not linked', { printers: [{ id: 'p1', osPrinterName: null, status: 'online' }] }],
    ['agent not connected to the printer', { agents: [{ status: 'online', connectedPrinterIds: ['other'] }] }],
    ['empty menu', { printOptions: { ...menu, papers: [] } }],
    ['existing shop (autoLive false)', { autoLive: false }],
    ['already rejected by an admin', { verificationStatus: 'rejected' }],
    ['already verified (admin unpublished it)', { verificationStatus: 'verified' }],
    ['already published', { publishedAt: new Date() }],
  ])('does not publish: %s', async (_name, over) => {
    findUnique.mockResolvedValue(readyShop(over));
    expect(await publishIfReady('s1')).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('publishIfReady with the PrintQ Simulator (PSO-1)', () => {
  const saved = { NODE_ENV: env.NODE_ENV, ALLOW: env.ALLOW_SIMULATED_PRINT_COMPLETION };
  const simulatorShop = () => readyShop({ printers: [{ id: 'p1', osPrinterName: 'PrintQ Simulator', status: 'online' }] });
  beforeEach(() => {
    findUnique.mockReset();
    updateMany.mockReset().mockResolvedValue({ count: 1 });
  });
  afterEach(() => {
    env.NODE_ENV = saved.NODE_ENV;
    env.ALLOW_SIMULATED_PRINT_COMPLETION = saved.ALLOW;
  });
  const asProduction = () => {
    env.NODE_ENV = 'production';
    env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
  };

  it('never takes a simulator-only shop live in production (its orders could not finish)', async () => {
    asProduction();
    findUnique.mockResolvedValue(simulatorShop());
    expect(await publishIfReady('s1')).toBe(false);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('takes the shop live in production once a real printer is connected next to the simulator', async () => {
    asProduction();
    findUnique.mockResolvedValue(readyShop({
      printers: [
        { id: 'p1', osPrinterName: 'PrintQ Simulator', status: 'online' },
        { id: 'p2', osPrinterName: 'HP LaserJet', status: 'online' },
      ],
      agents: [{ status: 'online', connectedPrinterIds: ['p1', 'p2'] }],
    }));
    expect(await publishIfReady('s1')).toBe(true);
  });

  it('still lets the simulator take a shop live in development', async () => {
    env.NODE_ENV = 'development';
    findUnique.mockResolvedValue(simulatorShop());
    expect(await publishIfReady('s1')).toBe(true);
  });
});
