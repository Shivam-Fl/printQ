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
export interface AdminClaims {
  typ: 'admin';
  sub: string;
  role: 'platform_admin';
  sv: number;
}
export type AuthClaims = StudentClaims | ShopClaims | AdminClaims;

export function signStudentToken(studentId: string): string {
  return jwt.sign({ typ: 'student' }, env.JWT_SECRET, { subject: studentId, expiresIn: '30d' });
}

export function signShopToken(shopUserId: string, shopId: string, role: 'owner' | 'staff'): string {
  return jwt.sign({ typ: 'shop', shopId, role }, env.JWT_SECRET, {
    subject: shopUserId,
    expiresIn: '12h',
  });
}

/** Platform administration is deliberately a separate identity domain from a shop owner. */
export function signAdminToken(adminId: string, sessionVersion: number): string {
  return jwt.sign({ typ: 'admin', role: 'platform_admin', sv: sessionVersion }, env.JWT_SECRET, {
    subject: adminId,
    expiresIn: '4h',
  });
}

/** Lifetime of a link-able file preview token. Short on purpose: it may land in a URL. */
export const PREVIEW_TOKEN_TTL_SECONDS = 120;

/**
 * Single-purpose token for opening one student's one file in a new tab (a plain
 * link cannot carry an Authorization header). It is NOT a session token: it
 * only works on the preview route and only for `fileId`.
 */
export function signPreviewToken(studentId: string, fileId: string): string {
  return jwt.sign({ typ: 'file-preview', fid: fileId }, env.JWT_SECRET, {
    subject: studentId,
    expiresIn: PREVIEW_TOKEN_TTL_SECONDS,
  });
}

/** The student id when `token` is a valid, unexpired preview token for exactly `fileId`. */
export function verifyPreviewToken(token: string, fileId: string): string | null {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET) as jwt.JwtPayload;
    if (payload.typ === 'file-preview' && payload.fid === fileId && typeof payload.sub === 'string') {
      return payload.sub;
    }
    return null;
  } catch {
    return null;
  }
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
    if (payload.typ === 'admin' && typeof payload.sub === 'string' && payload.role === 'platform_admin'
      && Number.isSafeInteger(payload.sv) && payload.sv >= 0) {
      return { typ: 'admin', sub: payload.sub, role: 'platform_admin', sv: payload.sv };
    }
    return null;
  } catch {
    return null;
  }
}
