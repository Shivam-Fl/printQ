import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { verifyToken } from '../lib/tokens.js';
import { hashAgentToken } from '../lib/otp.js';
import { unauthorized } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      student?: { id: string };
      shopUser?: { id: string; shopId: string; role: 'owner' | 'staff' };
      admin?: { id: string; role: 'platform_admin' };
      agent?: { id: string; shopId: string; connectedPrinterIds: string[] };
      /** Firebase App Check claim, populated only after server verification. */
      firebaseAppCheck?: { appId: string };
    }
  }
}

function bearer(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

export function requireStudent(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'student') return next(unauthorized());
  req.student = { id: claims.sub };
  next();
}

/**
 * Same as requireStudent but also accepts ?token= — needed only for the PDF
 * preview iframe, where the browser can't attach an Authorization header.
 */
export function requireStudentAllowQueryToken(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const token = bearer(req) ?? (typeof req.query.token === 'string' ? req.query.token : null);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'student') return next(unauthorized());
  req.student = { id: claims.sub };
  next();
}

export function requireShopUser(req: Request, _res: Response, next: NextFunction): void {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'shop') return next(unauthorized());
  req.shopUser = { id: claims.sub, shopId: claims.shopId, role: claims.role };
  next();
}

export function requireShopOwner(req: Request, res: Response, next: NextFunction): void {
  requireShopUser(req, res, (err?: unknown) => {
    if (err) return next(err as Error);
    if (req.shopUser?.role !== 'owner') return next(unauthorized('Owner access required'));
    next();
  });
}

/** Platform administrators are never derived from a shop user or student token. */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  const claims = token ? verifyToken(token) : null;
  if (!claims || claims.typ !== 'admin' || claims.role !== 'platform_admin') return next(unauthorized());
  const admin = await prisma.adminUser.findUnique({ where: { id: claims.sub }, select: { active: true, role: true, sessionVersion: true } });
  if (!admin?.active || admin.role !== 'platform_admin' || admin.sessionVersion !== claims.sv) return next(unauthorized());
  req.admin = { id: claims.sub, role: admin.role };
  next();
}

/** Agents authenticate with their opaque token (x-agent-token header). */
export async function requireAgent(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.headers['x-agent-token'];
  if (typeof token !== 'string' || token.length < 32) return next(unauthorized());
  const agent = await prisma.agent.findUnique({ where: { tokenHash: hashAgentToken(token) } });
  if (!agent) return next(unauthorized());
  req.agent = {
    id: agent.id,
    shopId: agent.shopId,
    connectedPrinterIds: agent.connectedPrinterIds,
  };
  next();
}
