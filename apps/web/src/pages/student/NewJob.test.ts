import { describe, expect, it } from 'vitest';
import { inkUnavailableNote } from './NewJob.js';

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
