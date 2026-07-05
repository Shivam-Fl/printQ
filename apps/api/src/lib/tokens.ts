import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface StudentClaims {
  typ: 'student';
  sub: string;
}
export interface ShopClaims {
  typ: 'shop';
  sub: string;
  shopId: string;
  role: 'owner' | 'staff';
}
export type AuthClaims = StudentClaims | ShopClaims;

export function signStudentToken(studentId: string): string {
  return jwt.sign({ typ: 'student' }, env.JWT_SECRET, { subject: studentId, expiresIn: '30d' });
}

export function signShopToken(shopUserId: string, shopId: string, role: 'owner' | 'staff'): string {
  return jwt.sign({ typ: 'shop', shopId, role }, env.JWT_SECRET, {
    subject: shopUserId,
    expiresIn: '12h',
  });
}

/** Returns null instead of throwing — callers decide the 401. */
export function verifyToken(token: string): AuthClaims | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    if (payload.typ === 'student' && typeof payload.sub === 'string') {
      return { typ: 'student', sub: payload.sub };
    }
    if (
      payload.typ === 'shop' &&
      typeof payload.sub === 'string' &&
      typeof payload.shopId === 'string' &&
      (payload.role === 'owner' || payload.role === 'staff')
    ) {
      return { typ: 'shop', sub: payload.sub, shopId: payload.shopId, role: payload.role };
    }
    return null;
  } catch {
    return null;
  }
}
