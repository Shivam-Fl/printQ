import { describe, expect, it } from 'vitest';
import { shouldGrantPermission } from './desktopPermissions.js';

const trusted = (url: string) => url.startsWith('https://printqs.com');

describe('shouldGrantPermission', () => {
  it('grants geolocation to trusted PrintQs pages only', () => {
    expect(shouldGrantPermission('geolocation', 'https://printqs.com/dashboard/setup', trusted)).toBe(true);
    expect(shouldGrantPermission('geolocation', 'https://evil.example/', trusted)).toBe(false);
  });
  it('allows the dashboard permissions on trusted pages, denies them elsewhere', () => {
    expect(shouldGrantPermission('notifications', 'https://printqs.com/', trusted)).toBe(true);
    expect(shouldGrantPermission('notifications', 'https://evil.example/', trusted)).toBe(false);
  });
  it('denies every other permission by default', () => {
    for (const permission of ['media', 'midi', 'openExternal', 'hid', 'usb', 'clipboard-read']) {
      expect(shouldGrantPermission(permission, 'https://printqs.com/', trusted)).toBe(false);
    }
  });
});
