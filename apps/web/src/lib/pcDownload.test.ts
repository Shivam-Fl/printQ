import { describe, expect, it } from 'vitest';
import { displayUrl, isPhoneLike, pcPageUrl } from './pcDownload.js';

describe('counter-computer download link', () => {
  it('builds the /pc link from the current site', () => {
    expect(pcPageUrl('https://printqs.com')).toBe('https://printqs.com/pc');
    expect(pcPageUrl('http://localhost:5173/')).toBe('http://localhost:5173/pc');
  });

  it('shows the link the way an owner types it', () => {
    expect(displayUrl('https://printqs.com/pc')).toBe('printqs.com/pc');
    expect(displayUrl('https://www.printqs.com/pc')).toBe('printqs.com/pc');
  });

  it('treats phones and tablets as unable to run the Windows app', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
    const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36';
    expect(isPhoneLike(false, android)).toBe(true);
    expect(isPhoneLike(false, iphone)).toBe(true);
    expect(isPhoneLike(true, windows)).toBe(true); // iPadOS reports a desktop UA; the coarse pointer catches it
    expect(isPhoneLike(false, windows)).toBe(false);
  });
});
