import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { signPreviewToken, signStudentToken, verifyPreviewToken, verifyToken } from '../../lib/tokens.js';
import { redactUrl } from '../../lib/logger.js';
import { requireStudentOrPreviewToken } from '../../middleware/auth.js';

const FILE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function run(req: Partial<Request>) {
  const next = vi.fn();
  const full = { headers: {}, query: {}, params: {}, ...req } as Request;
  requireStudentOrPreviewToken(full, {} as Response, next);
  return { next, req: full };
}

describe('file preview tokens', () => {
  it('are bound to one file, one student and a short lifetime', () => {
    const token = signPreviewToken('student-1', FILE);
    expect(verifyPreviewToken(token, FILE)).toBe('student-1');
    expect(verifyPreviewToken(token, OTHER)).toBeNull();
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };
    expect(exp - iat).toBeLessThanOrEqual(120);
  });

  it('are not session tokens', () => {
    expect(verifyToken(signPreviewToken('student-1', FILE))).toBeNull();
  });

  it('expire', () => {
    const expired = jwt.sign({ typ: 'file-preview', fid: FILE }, env.JWT_SECRET, { subject: 's', expiresIn: -5 });
    expect(verifyPreviewToken(expired, FILE)).toBeNull();
  });
});

describe('requireStudentOrPreviewToken', () => {
  it('accepts the session token in the Authorization header', () => {
    const { next, req } = run({ headers: { authorization: `Bearer ${signStudentToken('s1')}` }, params: { id: FILE } });
    expect(next).toHaveBeenCalledWith();
    expect(req.student).toEqual({ id: 's1' });
  });

  it('accepts a preview token for that file in ?pt=', () => {
    const { next, req } = run({ query: { pt: signPreviewToken('s1', FILE) }, params: { id: FILE } });
    expect(next).toHaveBeenCalledWith();
    expect(req.student).toEqual({ id: 's1' });
  });

  it('rejects a preview token minted for a different file', () => {
    const { next } = run({ query: { pt: signPreviewToken('s1', OTHER) }, params: { id: FILE } });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });

  it('never accepts the long-lived session token from the URL', () => {
    for (const key of ['token', 'pt']) {
      const { next } = run({ query: { [key]: signStudentToken('s1') }, params: { id: FILE } });
      expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
    }
  });

  it('does not let a preview token act as a bearer session', () => {
    const { next } = run({ headers: { authorization: `Bearer ${signPreviewToken('s1', FILE)}` }, params: { id: FILE } });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });
});

describe('log redaction of URL credentials', () => {
  it('masks pt/token query values', () => {
    expect(redactUrl(`/api/files/${FILE}/preview?pt=eyJabc.def&x=1`)).toBe(`/api/files/${FILE}/preview?pt=[redacted]&x=1`);
    expect(redactUrl('/a?x=1&token=secret')).toBe('/a?x=1&token=[redacted]');
    expect(redactUrl('/healthz')).toBe('/healthz');
  });
});
