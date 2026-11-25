import { describe, expect, it } from 'vitest';
import {
  compileRange,
  excludedFromRange,
  orderPages,
  partSelectedCount,
  rangeProblem,
  selectedCount,
  setAllPages,
  setPartPages,
  togglePage,
  type DocPart,
} from './pageSelection.js';

const notes: DocPart = { fileId: 'a', name: 'notes.pdf', pages: 4 };
const cover: DocPart = { fileId: 'b', name: 'cover.jpg', pages: 1 };
const lab: DocPart = { fileId: 'c', name: 'lab.docx', pages: 3 };

describe('page-by-page selection over a multi-file order', () => {
  it('numbers pages across files in print order', () => {
    expect(orderPages([cover, notes]).map((p) => [p.fileId, p.page, p.docPage])).toEqual([
      ['b', 1, 1], ['a', 1, 2], ['a', 2, 3], ['a', 3, 4], ['a', 4, 5],
    ]);
  });

  it('prints everything (null range) until a page is skipped', () => {
    expect(compileRange([notes, cover, lab], {})).toBeNull();
    const skipped = togglePage({}, 'a', 2);
    expect(compileRange([notes, cover, lab], skipped)).toBe('1,3-8');
    expect(selectedCount([notes, cover, lab], skipped)).toBe(7);
    expect(partSelectedCount(notes, skipped)).toBe(3);
    // toggling again prints it again
    expect(compileRange([notes, cover, lab], togglePage(skipped, 'a', 2))).toBeNull();
  });

  it('keeps a choice attached to its file when files are reordered', () => {
    const skipped = togglePage({}, 'c', 1); // lab.docx page 1
    expect(compileRange([notes, cover, lab], skipped)).toBe('1-5,7-8');
    expect(compileRange([lab, notes, cover], skipped)).toBe('2-8');
  });

  it('skips or selects a whole file, or the whole order', () => {
    const noCover = setPartPages({}, cover, false);
    expect(compileRange([notes, cover, lab], noCover)).toBe('1-4,6-8');
    expect(compileRange([notes, cover, lab], setPartPages(noCover, cover, true))).toBeNull();
    expect(compileRange([notes, cover], setAllPages([notes, cover], false))).toBe('');
    expect(rangeProblem('')).toBe('Choose at least one page to print.');
    expect(rangeProblem(null)).toBeNull();
  });

  it('reads a typed range over the whole order back into per-file choices', () => {
    const excluded = excludedFromRange([notes, cover, lab], '1-2, 5, 8');
    expect(excluded).toEqual({ a: [3, 4], c: [1, 2] });
    expect(compileRange([notes, cover, lab], excluded)).toBe('1-2,5,8');
    expect(() => excludedFromRange([notes], '9')).toThrow();
  });

  it('flags a selection too fragmented to send', () => {
    const big: DocPart = { fileId: 'x', name: 'big.pdf', pages: 500 };
    let excluded = {};
    for (let p = 2; p <= 500; p += 2) excluded = togglePage(excluded, 'x', p);
    const range = compileRange([big], excluded)!;
    expect(range.startsWith('1,3,5')).toBe(true);
    expect(rangeProblem(range)).toBeNull(); // every other page of 500 still fits
  });
});
