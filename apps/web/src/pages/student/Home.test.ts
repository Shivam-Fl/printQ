import { describe, expect, it } from 'vitest';
import { resolveNewPrintAction } from './Home.js';

describe('home new print action', () => {
  it('opens the picker when the student has multiple remembered shops', () => {
    expect(resolveNewPrintAction('shop-a', [{ slug: 'shop-a' }, { slug: 'shop-b' }])).toEqual({ kind: 'picker' });
  });

  it('routes a no-history student to the directory', () => {
    expect(resolveNewPrintAction(null, [])).toEqual({ kind: 'directory' });
  });

  it('opens the only available shop directly', () => {
    expect(resolveNewPrintAction('stale-shop', [{ slug: 'shop-a' }])).toEqual({ kind: 'shop', slug: 'shop-a' });
  });
});
