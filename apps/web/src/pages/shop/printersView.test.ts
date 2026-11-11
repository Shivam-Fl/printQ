import { describe, expect, it } from 'vitest';
import { detectedEmptyState, guessPaperSizes, practiceOnly, unlinkedDetectedPrinters } from './printersView.js';

describe('guessPaperSizes', () => {
  it('keeps A4 as the default and adds A3 when the driver reports it', () => {
    expect(guessPaperSizes([])).toEqual(['A4']);
    expect(guessPaperSizes(['A4', 'A3', 'Letter'])).toEqual(['A4', 'A3']);
    expect(guessPaperSizes(['Letter'])).toEqual(['A4']);
  });
});

describe('detectedEmptyState', () => {
  it('asks for a counter computer only when none is connected', () => {
    const none = detectedEmptyState({ agentsOnline: 0, agentsTotal: 0, linkedPrinters: 0 });
    expect(none.body).toMatch(/connect a counter computer/i);
    expect(none.connect).toBe(true);
  });

  it('never says "connect a computer" while the PC is online', () => {
    const linked = detectedEmptyState({ agentsOnline: 1, agentsTotal: 1, linkedPrinters: 1 });
    expect(linked.title).toMatch(/all printers are added/i);
    expect(linked.connect).toBe(false);
    const nothingFound = detectedEmptyState({ agentsOnline: 1, agentsTotal: 1, linkedPrinters: 0 });
    expect(nothingFound.body).not.toMatch(/connect a counter computer/i);
    expect(nothingFound.connect).toBe(false);
  });

  it('says the PC is offline when one was connected before', () => {
    expect(detectedEmptyState({ agentsOnline: 0, agentsTotal: 1, linkedPrinters: 1 }).title).toMatch(/offline/i);
  });
});

describe('detected printers and practice mode', () => {
  it('lists each reported printer once, minus the ones already added', () => {
    const agents = [
      { detectedPrinters: [{ name: 'HP LaserJet', paperSizes: ['A4'] }, { name: 'Epson L3250', paperSizes: ['A4', 'A3'] }] },
      { detectedPrinters: [{ name: 'HP LaserJet', paperSizes: ['A4'] }] },
      { detectedPrinters: null },
    ];
    expect(unlinkedDetectedPrinters(agents, [{ osPrinterName: 'Epson L3250' }]).map((d) => d.name)).toEqual(['HP LaserJet']);
  });
  it('keeps the practice warning while the simulator is the only added printer', () => {
    const isSim = (name: string | null) => name === 'PrintQ Simulator';
    expect(practiceOnly([{ osPrinterName: 'PrintQ Simulator' }], isSim)).toBe(true);
    expect(practiceOnly([{ osPrinterName: 'PrintQ Simulator' }, { osPrinterName: 'HP LaserJet' }], isSim)).toBe(false);
    expect(practiceOnly([], isSim)).toBe(false);
    expect(practiceOnly([{ osPrinterName: null }], isSim)).toBe(false);
  });
});
