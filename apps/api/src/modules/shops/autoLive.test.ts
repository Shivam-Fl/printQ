import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma.js', () => ({ prisma: { shop: { findUnique, updateMany }, $disconnect: vi.fn() } }));
vi.mock('../public/cache.js', () => ({ invalidatePublicCaches: vi.fn() }));

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
      where: expect.objectContaining({ verificationStatus: 'draft', publishedAt: null, autoLive: true }),
      data: expect.objectContaining({ verificationStatus: 'verified', publishedAt: expect.any(Date) }),
    }));
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
