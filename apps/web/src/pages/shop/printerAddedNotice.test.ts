import { describe, expect, it } from 'vitest';
import { afterPrinterAdded, isSimulatorPrinterName, type SetupAfterAdd } from './printerAddedNotice.js';

function setup(over: Partial<SetupAfterAdd> = {}, counts: Partial<SetupAfterAdd['counts']> = {}): SetupAfterAdd {
  return {
    locationReady: true,
    pricingReady: true,
    printerReady: true,
    agentReady: true,
    ready: true,
    visibility: { state: 'live', reason: null },
    studentUrl: 'https://printqs.com/s/ganesh-xerox',
    ...over,
    counts: { linkedPrinters: 1, onlinePrinters: 1, agents: 1, onlineAgents: 1, detectedPrinters: 0, ...counts },
  };
}

describe('after Add & configure (PSO-6)', () => {
  it('says the shop is live and links the student page and QR', () => {
    const notice = afterPrinterAdded(setup(), 'HP LaserJet');
    expect(notice.kind).toBe('live');
    expect(notice.title).toBe('Printer added — your shop is live');
    expect(notice.studentUrl).toBe('https://printqs.com/s/ganesh-xerox');
    expect(notice.to).toBe('/dashboard/setup');
  });
  it('names the next missing step when the shop is not live yet', () => {
    const notice = afterPrinterAdded(setup({ locationReady: false, ready: false, visibility: { state: 'not_ready', reason: null } }), 'HP LaserJet');
    expect(notice.kind).toBe('next');
    expect(notice.text).toBe('Next: Save your shop location.');
    expect(notice.studentUrl).toBeNull();
  });
});

describe('simulator (PSO-1)', () => {
  it('recognises the app simulator by name', () => {
    expect(isSimulatorPrinterName('PrintQ Simulator')).toBe(true);
    expect(isSimulatorPrinterName('HP LaserJet')).toBe(false);
    expect(isSimulatorPrinterName(undefined)).toBe(false);
  });
  it('never says "live" when the only printer is the simulator', () => {
    // the API leaves the simulator out of linkedPrinters and counts it in simulatorPrinters
    const notLive = { ready: false, agentReady: false, printerReady: false, visibility: { state: 'not_ready' as const, reason: null } };
    const fromApi = afterPrinterAdded(setup(notLive, { linkedPrinters: 0, onlinePrinters: 0, simulatorPrinters: 1 }), 'PrintQ Simulator');
    expect(fromApi.kind).toBe('practice');
    expect(fromApi.title).not.toMatch(/live/);
    // an older API without simulatorPrinters: the added name still gives it away
    expect(afterPrinterAdded(setup(), 'PrintQ Simulator').kind).toBe('practice');
  });
  it('is live when the simulator is added next to a real printer', () => {
    expect(afterPrinterAdded(setup({}, { linkedPrinters: 1, onlinePrinters: 1, simulatorPrinters: 1 }), 'PrintQ Simulator').kind).toBe('live');
    expect(afterPrinterAdded(setup({}, { simulatorPrinters: 0 }), 'HP LaserJet').kind).toBe('live');
  });
});
