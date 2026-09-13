import { describe, expect, it } from 'vitest';
import { DEFAULT_PRINT_OPTIONS, PricingError, applyCoupon, applyPlatformMarkup, computePrice } from './pricing.js';
import type { JobSpecs, PrintOptions } from './types.js';

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
    const p = computePrice(base, 10, DEFAULT_PRINT_OPTIONS);
    expect(p.pagesPerCopy).toBe(10);
    expect(p.totalPaise).toBe(10 * 200);
    expect(p.paperLabel).toBe('A4');
  });

  it('multiplies by copies', () => {
    const p = computePrice({ ...base, copies: 3 }, 5, DEFAULT_PRINT_OPTIONS);
    expect(p.totalPaise).toBe(5 * 3 * 200);
  });

  it('uses the colour rate', () => {
    const p = computePrice({ ...base, color: true }, 2, DEFAULT_PRINT_OPTIONS);
    expect(p.totalPaise).toBe(2 * 1000);
  });

  it('respects page ranges (with de-duplication)', () => {
    const p = computePrice({ ...base, pageRange: '1-3,3,5' }, 10, DEFAULT_PRINT_OPTIONS);
    expect(p.pagesPerCopy).toBe(4);
    expect(p.totalPaise).toBe(4 * 200);
  });

  it('adds binding cost once per job, not per copy', () => {
    const p = computePrice({ ...base, copies: 2, binding: 'spiral_binding' }, 10, DEFAULT_PRINT_OPTIONS);
    expect(p.bindingPaise).toBe(3000);
    expect(p.bindingLabel).toBe('Spiral binding');
    expect(p.totalPaise).toBe(10 * 2 * 200 + 3000);
  });

  it('supports a custom shop paper like a college sheet', () => {
    const options: PrintOptions = {
      papers: [{ id: 'college', label: 'College sheet', bwPaise: 100, colorPaise: null }],
      bindings: [],
      duplexEnabled: false,
    };
    const p = computePrice({ ...base, paperSize: 'college' }, 4, options);
    expect(p.totalPaise).toBe(400);
    // colour not offered on this paper
    expect(() => computePrice({ ...base, paperSize: 'college', color: true }, 4, options)).toThrow(PricingError);
  });

  it('throws when the paper is not offered by the shop', () => {
    expect(() => computePrice({ ...base, paperSize: 'A3' }, 5, {
      papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: null }],
      bindings: [],
      duplexEnabled: false,
    })).toThrow(PricingError);
  });

  it('uses integer paise throughout', () => {
    const p = computePrice({ ...base, copies: 7 }, 13, DEFAULT_PRINT_OPTIONS);
    expect(Number.isInteger(p.totalPaise)).toBe(true);
  });
});

describe('applyCoupon', () => {
  it('applies a percent-off discount', () => {
    const p = computePrice(base, 10, DEFAULT_PRINT_OPTIONS); // 2000 paise
    const discounted = applyCoupon(p, { code: 'TEN', percentOff: 10, paiseOff: null });
    expect(discounted.discountPaise).toBe(200);
    expect(discounted.totalPaise).toBe(1800);
  });

  it('applies a flat paise-off discount', () => {
    const p = computePrice(base, 10, DEFAULT_PRINT_OPTIONS); // 2000 paise
    const discounted = applyCoupon(p, { code: 'FLAT500', percentOff: null, paiseOff: 500 });
    expect(discounted.discountPaise).toBe(500);
    expect(discounted.totalPaise).toBe(1500);
  });

  it('never discounts below the minimum order floor', () => {
    const p = computePrice(base, 1, DEFAULT_PRINT_OPTIONS); // 200 paise
    const discounted = applyCoupon(p, { code: 'HUGE', percentOff: null, paiseOff: 10_000 });
    expect(discounted.totalPaise).toBe(100);
  });
});

describe('applyPlatformMarkup', () => {
  it('turns a shop base rate of ₹2 into a ₹2.50 student rate at 25%', () => {
    const basePrice = computePrice(base, 3, DEFAULT_PRINT_OPTIONS);
    const studentPrice = applyPlatformMarkup(basePrice, 2_500);
    expect(basePrice.perPagePaise).toBe(200);
    expect(studentPrice.perPagePaise).toBe(250);
    expect(studentPrice.totalPaise).toBe(750);
  });

  it('marks up finishing while preserving exact integer totals', () => {
    const basePrice = computePrice({ ...base, binding: 'spiral_binding' }, 1, DEFAULT_PRINT_OPTIONS);
    const studentPrice = applyPlatformMarkup(basePrice, 2_500);
    expect(studentPrice.bindingPaise).toBe(3_750);
    expect(studentPrice.totalPaise).toBe(4_000);
  });
});
