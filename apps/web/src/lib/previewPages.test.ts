import { describe, expect, it } from 'vitest';
import { previewPageWidth, selectedPreviewPages } from './previewPages.js';

describe('preview page selection', () => {
  it('shows every page when no range is set', () => {
    expect(selectedPreviewPages(4, null)).toEqual([1, 2, 3, 4]);
  });
  it('respects the selected page range', () => {
    expect(selectedPreviewPages(12, '2-4, 8, 11-12')).toEqual([2, 3, 4, 8, 11, 12]);
  });
  it('falls back to all pages for an invalid or out-of-range value', () => {
    expect(selectedPreviewPages(3, 'abc')).toEqual([1, 2, 3]);
    expect(selectedPreviewPages(3, '1-9')).toEqual([1, 2, 3]);
  });
  it('sizes pages from the container and zoom', () => {
    expect(previewPageWidth(300, 1)).toBe(300);
    expect(previewPageWidth(300, 2)).toBe(600);
    expect(previewPageWidth(10, 1)).toBe(120);
  });
});
