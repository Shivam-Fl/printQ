import { describe, expect, it } from 'vitest';
import { isProtectedStudentPath } from './SessionGuard.js';

describe('SessionGuard route policy', () => {
  it.each(['/home', '/profile', '/jobs', '/jobs/abc', '/s/shop-a/file/123'])('redirects from %s', (p) => {
    expect(isProtectedStudentPath(p)).toBe(true);
  });
  it.each(['/', '/login', '/shops', '/s/shop-a', '/privacy', '/dashboard'])('stays on %s', (p) => {
    expect(isProtectedStudentPath(p)).toBe(false);
  });
});
