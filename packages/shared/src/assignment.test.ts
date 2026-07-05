import { describe, expect, it } from 'vitest';
import { rankPrinters } from './assignment.js';
import type { JobSpecs, PrinterProfile, QueuedJobLite } from './types.js';

const specs: JobSpecs = {
  copies: 1,
  paperSize: 'A4',
  color: false,
  duplex: false,
  binding: null,
  pageRange: null,
};

function printer(overrides: Partial<PrinterProfile>): PrinterProfile {
  return {
    id: 'p1',
    label: 'P',
    paperSizesLoaded: ['A4'],
    colorSupport: false,
    finishingOptions: [],
    avgPagesPerMinute: 20,
    status: 'online',
    ...overrides,
  };
}

describe('rankPrinters', () => {
  it('filters out offline and jammed printers', () => {
    const result = rankPrinters(
      [printer({ id: 'a', status: 'offline' }), printer({ id: 'b', status: 'jammed' })],
      specs,
      5,
      [],
    );
    expect(result.recommended).toBeNull();
    expect(result.eligible).toHaveLength(0);
  });

  it('filters by paper size, colour and finishing capability', () => {
    const printers = [
      printer({ id: 'a4only' }),
      printer({ id: 'a3', paperSizesLoaded: ['A3'] }),
      printer({ id: 'colour', colorSupport: true }),
      printer({ id: 'spiral', finishingOptions: ['spiral_binding'] }),
    ];
    const colourJob = rankPrinters(printers, { ...specs, color: true }, 5, []);
    expect(colourJob.eligible.map((e) => e.printerId)).toEqual(['colour']);

    const spiralJob = rankPrinters(printers, { ...specs, binding: 'spiral_binding' }, 5, []);
    expect(spiralJob.eligible.map((e) => e.printerId)).toEqual(['spiral']);
  });

  it('recommends the printer with the shortest estimated completion', () => {
    const printers = [
      printer({ id: 'busy', avgPagesPerMinute: 20 }),
      printer({ id: 'free', avgPagesPerMinute: 20 }),
    ];
    const queued: QueuedJobLite[] = [
      { id: 'j1', assignedPrinterId: 'busy', pages: 100, copies: 1 },
    ];
    const result = rankPrinters(printers, specs, 5, queued);
    expect(result.recommended?.printerId).toBe('free');
  });

  it('a fast busy printer can beat a slow free one', () => {
    const printers = [
      printer({ id: 'fast-busy', avgPagesPerMinute: 60 }),
      printer({ id: 'slow-free', avgPagesPerMinute: 2 }),
    ];
    const queued: QueuedJobLite[] = [
      { id: 'j1', assignedPrinterId: 'fast-busy', pages: 20, copies: 1 },
    ];
    // fast-busy: (20+10)/60 = 1 min; slow-free: 10/2 = 5 min
    const result = rankPrinters(printers, { ...specs, copies: 2 }, 5, queued);
    expect(result.recommended?.printerId).toBe('fast-busy');
  });

  it('counts copies in queue load', () => {
    const printers = [printer({ id: 'a' }), printer({ id: 'b' })];
    const queued: QueuedJobLite[] = [
      { id: 'j1', assignedPrinterId: 'a', pages: 10, copies: 5 }, // 50 pages
      { id: 'j2', assignedPrinterId: 'b', pages: 10, copies: 1 }, // 10 pages
    ];
    const result = rankPrinters(printers, specs, 1, queued);
    expect(result.recommended?.printerId).toBe('b');
  });
});
