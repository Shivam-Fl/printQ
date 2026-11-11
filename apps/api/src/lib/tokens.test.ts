import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { signAdminToken, signShopToken, signStudentToken, verifyToken } from './tokens.js';

describe('separate authentication claims', () => {
  it('issues a platform-admin token that cannot be mistaken for a shop or student token', () => {
    const claims = verifyToken(signAdminToken('0ce73c87-4b64-4a53-af75-96f8b56860c3', 2));
    expect(claims).toEqual({
      typ: 'admin',
      sub: '0ce73c87-4b64-4a53-af75-96f8b56860c3',
      role: 'platform_admin',
      sv: 2,
    });
  });

  it('keeps shop and student claims in their own authorization domains', () => {
    expect(verifyToken(signShopToken('shop-user', 'shop-id', 'owner'))?.typ).toBe('shop');
    expect(verifyToken(signStudentToken('student-id'))?.typ).toBe('student');
  });

  it('carries the student session version, and reads a token minted before versions as 0', () => {
    expect(verifyToken(signStudentToken('student-id', 3))).toEqual({ typ: 'student', sub: 'student-id', sv: 3 });
    const legacy = jwt.sign({ typ: 'student' }, env.JWT_SECRET, { subject: 'student-id', expiresIn: '1h' });
    expect(verifyToken(legacy)).toEqual({ typ: 'student', sub: 'student-id', sv: 0 });
  });
});
