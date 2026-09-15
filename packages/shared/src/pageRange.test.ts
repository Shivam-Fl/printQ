import { describe, expect, it } from 'vitest';
import { countSelectedPages, PageRangeError, parsePageRange } from './pageRange.js';

describe('parsePageRange', () => {
  it('parses single pages, ranges and mixes', () => {
    expect(parsePageRange('3', 10)).toEqual([3]);
    expect(parsePageRange('1-4', 10)).toEqual([1, 2, 3, 4]);
    expect(parsePageRange('1-2, 5, 8-9', 10)).toEqual([1, 2, 5, 8, 9]);
  });

  it('de-duplicates overlapping selections', () => {
    expect(parsePageRange('1-3,2-4', 10)).toEqual([1, 2, 3, 4]);
  });

  it('rejects malformed input', () => {
    for (const bad of ['', 'a-b', '1-', '-3', '1;3', '1..3']) {
      expect(() => parsePageRange(bad, 10), bad).toThrow();
    }
  });

  it('rejects out-of-bounds and inverted ranges', () => {
    expect(() => parsePageRange('11', 10)).toThrow(PageRangeError);
    expect(() => parsePageRange('0-2', 10)).toThrow();
    expect(() => parsePageRange('5-2', 10)).toThrow();
  });

  it('uses safe, actionable validation messages', () => {
    expect(() => parsePageRange('1-99', 3)).toThrow('Selected pages are outside this document');
    expect(() => parsePageRange('pages 1-3', 3)).toThrow('Use a format like 1-5,8');
  });
});

describe('countSelectedPages', () => {
  it('returns total pages when range is null', () => {
    expect(countSelectedPages(null, 42)).toBe(42);
  });
  it('counts the selected pages otherwise', () => {
    expect(countSelectedPages('1-3,7', 10)).toBe(4);
  });
});
