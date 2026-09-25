import { describe, expect, it } from 'vitest';
import { deriveCommissionSnapshot } from './service.js';

describe('deriveCommissionSnapshot', () => {
  it('reconciles positive commission without fractional paise', () => {
    const snapshot = deriveCommissionSnapshot(1_275, 1_000);
    expect(snapshot).toEqual({ commissionPaise: 275, shopFundedDiscountPaise: 0 });
    expect(1_000 + snapshot.commissionPaise - snapshot.shopFundedDiscountPaise).toBe(1_275);
  });

  it('records a coupon below shop base as an explicit shop-funded discount, never a negative receivable', () => {
    const snapshot = deriveCommissionSnapshot(950, 1_000);
    expect(snapshot).toEqual({ commissionPaise: 0, shopFundedDiscountPaise: 50 });
    expect(1_000 + snapshot.commissionPaise - snapshot.shopFundedDiscountPaise).toBe(950);
  });

  it('rejects non-integer or negative values', () => {
    expect(() => deriveCommissionSnapshot(100.5, 100)).toThrow(RangeError);
    expect(() => deriveCommissionSnapshot(100, -1)).toThrow(RangeError);
  });
});
