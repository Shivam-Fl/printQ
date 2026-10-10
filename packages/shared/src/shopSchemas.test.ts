import { describe, expect, it } from 'vitest';
import { printOptionsSchema, shopRegisterSchema } from './schemas.js';

describe('printOptionsSchema pricing sanity (OWN-11)', () => {
  const menu = (over: Record<string, unknown> = {}) => ({
    papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 1000 }],
    bindings: [{ id: 'stapling', label: 'Stapling', paise: 0 }],
    duplexEnabled: true,
    ...over,
  });
  const issues = (value: unknown) => {
    const r = printOptionsSchema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('accepts a normal menu and a B/W-only paper', () => {
    expect(printOptionsSchema.safeParse(menu()).success).toBe(true);
    expect(printOptionsSchema.safeParse(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: null }] })).success).toBe(true);
  });
  it('rejects duplicate paper ids (case-insensitive)', () => {
    const papers = [
      { id: 'A4', label: 'A4', bwPaise: 200, colorPaise: null },
      { id: 'a4', label: 'A4 again', bwPaise: 300, colorPaise: null },
    ];
    expect(issues(menu({ papers })).join()).toMatch(/duplicate paper/i);
  });
  it('rejects duplicate binding ids', () => {
    const bindings = [{ id: 'spiral', label: 'Spiral', paise: 3000 }, { id: 'spiral', label: 'Spiral 2', paise: 100 }];
    expect(issues(menu({ bindings })).join()).toMatch(/duplicate binding/i);
  });
  it('rejects a colour price below the B/W price', () => {
    const papers = [{ id: 'A4', label: 'A4', bwPaise: 500, colorPaise: 200 }];
    expect(issues(menu({ papers })).join()).toMatch(/colou?r price/i);
  });
  it('rejects more than Rs 100 per page and more than Rs 1000 for a binding', () => {
    expect(issues(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 10_001, colorPaise: null }] })).length).toBeGreaterThan(0);
    expect(issues(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 200, colorPaise: 10_001 }] })).length).toBeGreaterThan(0);
    expect(printOptionsSchema.safeParse(menu({ papers: [{ id: 'A4', label: 'A4', bwPaise: 10_000, colorPaise: 10_000 }] })).success).toBe(true);
    expect(issues(menu({ bindings: [{ id: 'x', label: 'X', paise: 100_001 }] })).length).toBeGreaterThan(0);
  });
  it('rejects the reserved binding id "none"', () => {
    expect(issues(menu({ bindings: [{ id: 'none', label: 'None', paise: 0 }] })).join()).toMatch(/none/i);
    expect(issues(menu({ bindings: [{ id: ' None ', label: 'None', paise: 0 }] })).join()).toMatch(/none/i);
  });
});

describe('shop registration messages name the field (OWN-12)', () => {
  const ok = { shopName: 'Test Shop', address: '12 Lane', ownerName: 'Owner', email: 'a@b.co', password: 'longenough' };
  const msg = (over: Record<string, unknown>) => {
    const r = shopRegisterSchema.safeParse({ ...ok, ...over });
    return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
  };
  it('accepts a valid body', () => expect(msg({})).toEqual([]));
  it('names email', () => expect(msg({ email: 'nope' })).toEqual(['email: Email is invalid']));
  it('names password length', () => expect(msg({ password: 'short' })).toEqual(['password: Password must be at least 8 characters']));
  it('names the other fields', () => {
    expect(msg({ shopName: ' ' })).toEqual(['shopName: Shop name must be at least 2 characters']);
    expect(msg({ address: 'ab' })).toEqual(['address: Address must be at least 3 characters']);
    expect(msg({ ownerName: '' })).toEqual(['ownerName: Owner name is required']);
  });
  it('names a missing field rather than "Required"', () => {
    const r = shopRegisterSchema.safeParse({ ...ok, email: undefined });
    expect(r.success ? '' : r.error.issues[0]!.message).toBe('Email is required');
  });
});
