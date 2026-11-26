import { describe, expect, it } from 'vitest';
import { buildParts, seedPerFile, settingsSummary, sheetsFor } from './fileSettings.js';
import { togglePage, type DocPart } from './pageSelection.js';

const notes: DocPart = { fileId: 'a', name: 'notes.pdf', pages: 4 };
const cover: DocPart = { fileId: 'b', name: 'cover.jpg', pages: 1 };
const defaults = { copies: 1, color: false, duplex: true };

describe('different settings per file', () => {
  it('starts every file from the order settings and keeps a file’s own choice', () => {
    const seeded = seedPerFile([notes, cover], { b: { copies: 3, color: true, duplex: false } }, defaults);
    expect(seeded).toEqual({ a: defaults, b: { copies: 3, color: true, duplex: false } });
  });

  it('turns files into print runs in print order, with only their chosen pages', () => {
    const perFile = { a: { copies: 2, color: false, duplex: true }, b: { copies: 1, color: true, duplex: false } };
    expect(buildParts([notes, cover], togglePage({}, 'a', 4), perFile, defaults)).toEqual([
      { pages: '1-3', copies: 2, color: false, duplex: true },
      { pages: '5', copies: 1, color: true, duplex: false },
    ]);
    // a file without its own settings uses the order's
    expect(buildParts([cover, notes], {}, {}, defaults)[1]).toEqual({ pages: '2-5', ...defaults });
  });

  it('counts sheets per run and says each file’s settings in a few words', () => {
    expect(sheetsFor([{ pages: '1-3', copies: 2, duplex: true }, { pages: '5', copies: 1, duplex: false }], 5)).toBe(5);
    expect(settingsSummary({ copies: 2, color: true, duplex: true })).toBe('Colour · 2 copies · both sides');
    expect(settingsSummary({ copies: 1, color: false, duplex: false }, false)).toBe('B/W · 1 copy');
  });
});
