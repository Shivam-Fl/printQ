import { describe, expect, it } from 'vitest';
import { filterPublishedHistoryShops, resolveNewPrintAction } from './Home.js';

describe('home new print action', () => {
  it('opens the picker when the student has multiple remembered shops', () => {
    expect(resolveNewPrintAction('shop-a', [{ slug: 'shop-a' }, { slug: 'shop-b' }])).toEqual({ kind: 'picker' });
  });

  it('routes a no-history student to the directory', () => {
    expect(resolveNewPrintAction(null, [])).toEqual({ kind: 'directory' });
  });

  it('sends a student who has not ordered yet to the shop they last opened, while it is published', () => {
    const published = [{ slug: 'qr-shop' }, { slug: 'other' }];
    expect(resolveNewPrintAction('qr-shop', [], published)).toEqual({ kind: 'shop', slug: 'qr-shop' });
    expect(resolveNewPrintAction('gone-shop', [], published)).toEqual({ kind: 'directory' });
    // order history always wins over the last opened shop
    expect(resolveNewPrintAction('qr-shop', [{ slug: 'other' }], published)).toEqual({ kind: 'shop', slug: 'other' });
  });

  it('opens the only available shop directly', () => {
    expect(resolveNewPrintAction('stale-shop', [{ slug: 'shop-a' }])).toEqual({ kind: 'shop', slug: 'shop-a' });
  });

  it('does not offer unpublished shops from a student’s old job history', () => {
    const recent = [
      { slug: 'old-qa-shop', name: 'Old QA shop' },
      { slug: 'verified-shop', name: 'Verified shop' },
    ];
    const visible = filterPublishedHistoryShops(recent, [{ slug: 'verified-shop' }]);
    expect(visible).toEqual([{ slug: 'verified-shop', name: 'Verified shop' }]);
    expect(resolveNewPrintAction('old-qa-shop', filterPublishedHistoryShops(recent, [])))
      .toEqual({ kind: 'directory' });
  });
});
