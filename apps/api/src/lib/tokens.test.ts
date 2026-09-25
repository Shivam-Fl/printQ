import { describe, expect, it } from 'vitest';
import { signAdminToken, signShopToken, signStudentToken, verifyToken } from './tokens.js';

describe('separate authentication claims', () => {
  it('issues a platform-admin token that cannot be mistaken for a shop or student token', () => {
    const claims = verifyToken(signAdminToken('0ce73c87-4b64-4a53-af75-96f8b56860c3'));
    expect(claims).toEqual({
      typ: 'admin',
      sub: '0ce73c87-4b64-4a53-af75-96f8b56860c3',
      role: 'platform_admin',
    });
  });

  it('keeps shop and student claims in their own authorization domains', () => {
    expect(verifyToken(signShopToken('shop-user', 'shop-id', 'owner'))?.typ).toBe('shop');
    expect(verifyToken(signStudentToken('student-id'))?.typ).toBe('student');
  });
});
