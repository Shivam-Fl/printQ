import { describe, expect, it } from 'vitest';
import { openFirst } from './ShopDirectory.js';

describe('shop directory order', () => {
  it('lists open shops before offline ones and keeps the nearest-first order inside each group', () => {
    const shops = [
      { slug: 'offline-near', open: false },
      { slug: 'open-mid', open: true },
      { slug: 'offline-far', open: false },
      { slug: 'open-far', open: true },
    ];
    expect(openFirst(shops).map((s) => s.slug)).toEqual(['open-mid', 'open-far', 'offline-near', 'offline-far']);
    expect(shops[0]!.slug).toBe('offline-near'); // input untouched
  });
});
