import { describe, expect, it } from 'vitest';
import { shouldGrantPermission } from './desktopPermissions.js';

const trusted = (url: string) => url.startsWith('https://printqs.com');

describe('shouldGrantPermission', () => {
  it('grants geolocation to trusted PrintQs pages only', () => {
    expect(shouldGrantPermission('geolocation', 'https://printqs.com/dashboard/setup', trusted)).toBe(true);
    expect(shouldGrantPermission('geolocation', 'https://evil.example/', trusted)).toBe(false);
  });
  it('keeps the previous default for other permissions', () => {
    expect(shouldGrantPermission('notifications', 'https://printqs.com/', trusted)).toBe(true);
  });
});
