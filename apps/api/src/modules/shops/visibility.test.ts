import { describe, expect, it } from 'vitest';
import { countDetectedPrinters, hasOnlinePrinterPath, shopVisibility, type ShopVisibilityInput } from './visibility.js';

const live: ShopVisibilityInput = {
  autoLive: true,
  verificationStatus: 'verified',
  publishedAt: new Date('2026-11-01T10:00:00Z'),
  campusId: null,
  campus: null,
  latitude: 18.5,
  longitude: 73.8,
  printerPathOnline: true,
  lastAdminAction: null,
};

describe('shopVisibility', () => {
  it('live when published and an online PC reaches an online printer', () => {
    expect(shopVisibility(live)).toEqual({ state: 'live', reason: null });
  });

  it('live_pc_offline (not "finish setup") when published but the PC is off', () => {
    expect(shopVisibility({ ...live, printerPathOnline: false })).toEqual({ state: 'live_pc_offline', reason: null });
  });

  it('hidden_by_admin after an admin unpublish, with the recorded reason when there is one', () => {
    const hidden = { ...live, publishedAt: null };
    expect(shopVisibility({ ...hidden, lastAdminAction: { action: 'shop.unpublished', metadata: null } }))
      .toEqual({ state: 'hidden_by_admin', reason: null });
    expect(shopVisibility({ ...hidden, lastAdminAction: { action: 'shop.unpublished', metadata: { reason: ' Wrong address ' } } }))
      .toEqual({ state: 'hidden_by_admin', reason: 'Wrong address' });
  });

  it('hidden_by_admin when rejected', () => {
    expect(shopVisibility({ ...live, verificationStatus: 'rejected', publishedAt: null }).state).toBe('hidden_by_admin');
  });

  it('campus_inactive when the attached campus is switched off, even if published', () => {
    expect(shopVisibility({ ...live, campusId: 'c1', campus: { isActive: false } })).toEqual({ state: 'campus_inactive', reason: null });
    expect(shopVisibility({ ...live, campusId: 'c1', campus: { isActive: true } }).state).toBe('live');
  });

  it('pending_review for a legacy manual-review shop that was submitted or verified but not yet published', () => {
    expect(shopVisibility({ ...live, autoLive: false, verificationStatus: 'submitted', publishedAt: null }).state).toBe('pending_review');
    expect(shopVisibility({ ...live, autoLive: false, publishedAt: null }).state).toBe('pending_review');
    expect(shopVisibility({ ...live, publishedAt: null, lastAdminAction: { action: 'shop.verified', metadata: null } }).state)
      .toBe('pending_review');
  });

  it('not_ready while an auto-live shop is still a draft (or an older client parked it in submitted)', () => {
    expect(shopVisibility({ ...live, verificationStatus: 'draft', publishedAt: null }).state).toBe('not_ready');
    expect(shopVisibility({ ...live, verificationStatus: 'submitted', publishedAt: null }).state).toBe('not_ready');
    expect(shopVisibility({ ...live, latitude: null, longitude: null }).state).toBe('not_ready');
  });
});

describe('hasOnlinePrinterPath', () => {
  it('needs an online agent connected to an online printer', () => {
    const printers = [{ id: 'p1', status: 'online' }, { id: 'p2', status: 'offline' }];
    expect(hasOnlinePrinterPath([{ status: 'online', connectedPrinterIds: ['p1'] }], printers)).toBe(true);
    expect(hasOnlinePrinterPath([{ status: 'offline', connectedPrinterIds: ['p1'] }], printers)).toBe(false);
    expect(hasOnlinePrinterPath([{ status: 'online', connectedPrinterIds: ['p2'] }], printers)).toBe(false);
  });
});

describe('countDetectedPrinters', () => {
  it('counts distinct OS printers seen by online PCs that are not linked yet', () => {
    const agents = [
      { status: 'online', detectedPrinters: [{ name: 'HP LaserJet' }, { name: 'Canon G3000' }] },
      { status: 'online', detectedPrinters: [{ name: 'HP LaserJet' }] },
      { status: 'offline', detectedPrinters: [{ name: 'Epson L3250' }] },
      { status: 'online', detectedPrinters: null },
    ];
    expect(countDetectedPrinters(agents, [])).toBe(2);
    expect(countDetectedPrinters(agents, [{ osPrinterName: 'HP LaserJet' }, { osPrinterName: null }])).toBe(1);
  });
});

describe('the PrintQ Simulator in production (PSO-1)', () => {
  const agents = [{ status: 'online', connectedPrinterIds: ['sim', 'hp'] }];
  const simulator = { id: 'sim', status: 'online', osPrinterName: 'PrintQ Simulator' };
  const real = { id: 'hp', status: 'online', osPrinterName: 'HP LaserJet' };

  it('does not count as an online printer path when practice only', () => {
    expect(hasOnlinePrinterPath(agents, [simulator], true)).toBe(false);
    expect(hasOnlinePrinterPath(agents, [simulator, real], true)).toBe(true);
    expect(hasOnlinePrinterPath(agents, [simulator], false)).toBe(true);
  });

  it('is not offered as a printer found on the PC when practice only', () => {
    const pc = [{ status: 'online', detectedPrinters: [{ name: 'PrintQ Simulator' }, { name: 'Canon G3000' }] }];
    expect(countDetectedPrinters(pc, [], true)).toBe(1);
    expect(countDetectedPrinters(pc, [], false)).toBe(2);
  });
});

