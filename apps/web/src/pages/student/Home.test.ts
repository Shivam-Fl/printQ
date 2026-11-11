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

  it('never drops a student on a closed shop: Find a shop instead', () => {
    const published = [{ slug: 'usual', open: false }, { slug: 'nearby', open: true }];
    // the only shop they ever used is closed right now
    expect(resolveNewPrintAction(null, [{ slug: 'usual' }], published)).toEqual({ kind: 'directory' });
    expect(resolveNewPrintAction('usual', [{ slug: 'usual' }], published)).toEqual({ kind: 'directory' });
    // no orders yet and the shop they last opened is closed
    expect(resolveNewPrintAction('usual', [], published)).toEqual({ kind: 'directory' });
    // it opens directly again once it is open
    expect(resolveNewPrintAction(null, [{ slug: 'usual' }], [{ slug: 'usual', open: true }])).toEqual({ kind: 'shop', slug: 'usual' });
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
