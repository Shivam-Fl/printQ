import { describe, expect, it } from 'vitest';
import { DEFAULT_RATE_CARD, computePrice } from './pricing.js';
import type { JobSpecs } from './types.js';

const base: JobSpecs = {
  copies: 1,
  paperSize: 'A4',
  color: false,
  duplex: false,
  binding: null,
  pageRange: null,
};

describe('computePrice', () => {
  it('prices a simple A4 B/W job', () => {
    const p = computePrice(base, 10, DEFAULT_RATE_CARD);
    expect(p.pagesPerCopy).toBe(10);
    expect(p.totalPaise).toBe(10 * 200);
  });

  it('multiplies by copies', () => {
    const p = computePrice({ ...base, copies: 3 }, 5, DEFAULT_RATE_CARD);
    expect(p.totalPaise).toBe(5 * 3 * 200);
  });

  it('uses the colour rate', () => {
    const p = computePrice({ ...base, color: true }, 2, DEFAULT_RATE_CARD);
    expect(p.totalPaise).toBe(2 * 1000);
  });

  it('respects page ranges (with de-duplication)', () => {
    const p = computePrice({ ...base, pageRange: '1-3,3,5' }, 10, DEFAULT_RATE_CARD);
    expect(p.pagesPerCopy).toBe(4); // 1,2,3,5
    expect(p.totalPaise).toBe(4 * 200);
  });

  it('adds binding cost once per job, not per copy', () => {
    const p = computePrice({ ...base, copies: 2, binding: 'spiral_binding' }, 10, DEFAULT_RATE_CARD);
    expect(p.bindingPaise).toBe(3000);
    expect(p.totalPaise).toBe(10 * 2 * 200 + 3000);
  });

  it('throws on out-of-bounds page ranges', () => {
    expect(() => computePrice({ ...base, pageRange: '1-11' }, 10, DEFAULT_RATE_CARD)).toThrow();
    expect(() => computePrice({ ...base, pageRange: '0-2' }, 10, DEFAULT_RATE_CARD)).toThrow();
  });

  it('throws when the shop has no rate for the requested combination', () => {
    expect(() =>
      computePrice({ ...base, paperSize: 'A3' }, 5, { pagePrices: { A4_bw: 200 }, bindingPrices: {} }),
    ).toThrow(/no rate configured/);
  });

  it('uses integer paise throughout (no float drift)', () => {
    const p = computePrice({ ...base, copies: 7 }, 13, DEFAULT_RATE_CARD);
    expect(Number.isInteger(p.totalPaise)).toBe(true);
  });
});
