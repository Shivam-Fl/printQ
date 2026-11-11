import jwt from 'jsonwebtoken';
import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { env } from '../../config/env.js';
import { signPreviewToken, signStudentToken, verifyPreviewToken, verifyToken } from '../../lib/tokens.js';
import { redactUrl } from '../../lib/logger.js';
import { requireStudentOrPreviewToken } from '../../middleware/auth.js';

// The session check reads Student.sessionVersion; s1 exists (version 0), s2 signed out once (version 1).
const versions = vi.hoisted((): Record<string, number> => ({ s1: 0, s2: 1 }));
vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    student: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id in versions ? { id: where.id, sessionVersion: versions[where.id] } : null),
    },
    $disconnect: vi.fn(async () => undefined),
  },
}));

const FILE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

async function run(req: Partial<Request>) {
  const next = vi.fn();
  const full = { headers: {}, query: {}, params: {}, ...req } as Request;
  await requireStudentOrPreviewToken(full, {} as Response, next);
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
  it('accepts the session token in the Authorization header', async () => {
    const { next, req } = await run({ headers: { authorization: `Bearer ${signStudentToken('s1')}` }, params: { id: FILE } });
    expect(next).toHaveBeenCalledWith();
    expect(req.student).toEqual({ id: 's1' });
  });

  it('rejects a session token issued before the student signed out, and accepts the new one', async () => {
    const old = await run({ headers: { authorization: `Bearer ${signStudentToken('s2', 0)}` }, params: { id: FILE } });
    expect(old.next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
    const current = await run({ headers: { authorization: `Bearer ${signStudentToken('s2', 1)}` }, params: { id: FILE } });
    expect(current.next).toHaveBeenCalledWith();
    expect(current.req.student).toEqual({ id: 's2' });
  });

  it('rejects a session token for a student who no longer exists', async () => {
    const { next } = await run({ headers: { authorization: `Bearer ${signStudentToken('gone')}` }, params: { id: FILE } });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });

  it('accepts a preview token for that file in ?pt=', async () => {
    const { next, req } = await run({ query: { pt: signPreviewToken('s1', FILE) }, params: { id: FILE } });
    expect(next).toHaveBeenCalledWith();
    expect(req.student).toEqual({ id: 's1' });
  });

  it('rejects a preview token minted for a different file', async () => {
    const { next } = await run({ query: { pt: signPreviewToken('s1', OTHER) }, params: { id: FILE } });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
  });

  it('never accepts the long-lived session token from the URL', async () => {
    for (const key of ['token', 'pt']) {
      const { next } = await run({ query: { [key]: signStudentToken('s1') }, params: { id: FILE } });
      expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 401 });
    }
  });

  it('does not let a preview token act as a bearer session', async () => {
    const { next } = await run({ headers: { authorization: `Bearer ${signPreviewToken('s1', FILE)}` }, params: { id: FILE } });
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
