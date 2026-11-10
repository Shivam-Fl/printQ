import { beforeEach, describe, expect, it } from 'vitest';
import { loadRemembered, saveRemembered, startingSpecs } from './printSettings.js';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  });
});

const papers = [{ id: 'A4' }, { id: 'A3' }];

describe('remembered print settings', () => {
  it('starts a first order at the cheapest defaults', () => {
    expect(startingSpecs(papers, true, null)).toEqual({ copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null });
  });
  it('brings back paper and sides per shop, never colour or binding', () => {
    saveRemembered('sharma', { paperSize: 'A3', duplex: true });
    const specs = startingSpecs(papers, true, loadRemembered('sharma'));
    expect(specs).toMatchObject({ paperSize: 'A3', duplex: true, color: false, binding: null, copies: 1 });
    expect(loadRemembered('other-shop')).toBeNull();
  });
  it('ignores a remembered paper the shop no longer offers, and sides when the shop stopped double-sided', () => {
    saveRemembered('sharma', { paperSize: 'Legal', duplex: true });
    expect(startingSpecs(papers, false, loadRemembered('sharma'))).toMatchObject({ paperSize: 'A4', duplex: false });
  });
  it('survives a corrupted entry', () => {
    store.set('printq:print-settings:sharma', '{not json');
    expect(loadRemembered('sharma')).toBeNull();
  });
});
