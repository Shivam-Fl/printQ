import { describe, expect, it } from 'vitest';
import { inkUnavailableNote, orderBlocker } from './NewJob.js';
import type { Draft, DraftItem } from '../../lib/orderDraft.js';

describe('checkout ink note', () => {
  it('says a B/W-only shop prints black & white only', () => {
    const papers = [
      { id: 'A4', label: 'A4', colorAvailable: false },
      { id: 'A3', label: 'A3', colorAvailable: false },
    ];
    expect(inkUnavailableNote(papers, 'A4')).toBe('This shop prints black & white only right now.');
  });

  it('points to another paper size when only that size has no colour', () => {
    const papers = [
      { id: 'A4', label: 'A4', colorAvailable: true },
      { id: 'A3', label: 'A3', colorAvailable: false },
    ];
    expect(inkUnavailableNote(papers, 'A4')).toBeNull();
    expect(inkUnavailableNote(papers, 'A3')).toBe('Colour isn’t available on A3 here. Choose another paper size for colour.');
  });
});

const item = (over: Partial<DraftItem>): DraftItem => ({
  key: Math.random().toString(36), name: 'a.pdf', size: 1, kind: 'pdf', status: 'ready', progress: 1, fileId: 'a', pages: 2, ...over,
});
const draft = (items: DraftItem[], doc: Draft['doc'] = null): Draft => ({
  slug: 's', items, doc, excluded: {}, notice: null, loadError: null, loading: false,
});

describe('what stops "Place order"', () => {
  it('waits for uploads, then preparation, then the join', () => {
    expect(orderBlocker(draft([]), null)).toEqual({ kind: 'fix', text: 'Add a file to continue.' });
    expect(orderBlocker(draft([item({ status: 'uploading' }), item({ status: 'uploading' })]), null)).toEqual({ kind: 'wait', text: 'Uploading 2 files…' });
    expect(orderBlocker(draft([item({ status: 'preparing' })]), null)?.text).toBe('Preparing 1 file…');
    const two = [item({ fileId: 'a' }), item({ fileId: 'b' })];
    expect(orderBlocker(draft(two), null)).toEqual({ kind: 'wait', text: 'Putting your files together…' });
    expect(orderBlocker(draft(two, { ids: ['a', 'b'], fileId: 'joined', status: 'preparing' }), null)?.kind).toBe('wait');
    expect(orderBlocker(draft(two, { ids: ['a', 'b'], fileId: 'joined', status: 'ready' }), null)).toBeNull();
  });

  it('treats a stale join (files rearranged since) as not ready', () => {
    const two = [item({ fileId: 'b' }), item({ fileId: 'a' })];
    expect(orderBlocker(draft(two, { ids: ['a', 'b'], fileId: 'joined', status: 'ready' }), null)?.kind).toBe('wait');
  });

  it('asks the student to act on a broken file, a failed join or an empty page choice', () => {
    expect(orderBlocker(draft([item({}), item({ status: 'failed', error: 'x' })]), null)?.text).toBe('One file could not be added. Remove it to continue.');
    expect(orderBlocker(draft([item({ fileId: 'a' }), item({ fileId: 'b' })], { ids: ['a', 'b'], fileId: '', status: 'failed', error: 'Nope' }), null)).toEqual({ kind: 'fix', text: 'Nope' });
    const one = draft([item({ fileId: 'a' })], { ids: ['a'], fileId: 'a', status: 'ready' });
    expect(orderBlocker(one, 'Choose at least one page to print.')).toEqual({ kind: 'fix', text: 'Choose at least one page to print.' });
  });
});
