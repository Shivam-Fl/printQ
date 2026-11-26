import { describe, expect, it } from 'vitest';
import { partPhrase, runFiles, specsText } from './jobStatus.js';

const files = [{ name: 'cover.jpg', pages: 1 }, { name: 'notes.pdf', pages: 6 }, { name: 'lab.pdf', pages: 3 }];
const runs = [
  { pages: '1', copies: 1, color: true, duplex: false },
  { pages: '8-10', copies: 1, color: false, duplex: false }, // notes.pdf had no page chosen
];

describe('an order with different settings per file, in student words', () => {
  it('names the file each run comes from, with pages counted inside that file', () => {
    expect(runFiles(runs, files)).toEqual([
      { name: 'cover.jpg', pages: 'All 1 page' },
      { name: 'lab.pdf', pages: 'All 3 pages' },
    ]);
    expect(runFiles([{ ...runs[1]!, pages: '3-4,7' }], files)).toEqual([{ name: 'notes.pdf', pages: 'Pages 2-3,6' }]);
    expect(runFiles(runs, null)).toEqual([null, null]); // names deleted after printing
  });

  it('sums the runs up on one line', () => {
    expect(partPhrase({ pages: '2-7', copies: 2, color: false, duplex: true })).toBe('B/W ×2, both sides');
    expect(specsText({ copies: 1, paperSize: 'A4', color: true, duplex: false, binding: null, pageRange: null, parts: runs }, 4))
      .toBe('A4 · 2 files: Colour ×1 + B/W ×1 · 4pp');
  });
});
