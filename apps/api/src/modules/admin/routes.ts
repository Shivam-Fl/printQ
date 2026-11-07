import { Router } from 'express';
import type { Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { signAdminToken } from '../../lib/tokens.js';
import { generateOtp, hashOtp, verifyOtpHash } from '../../lib/otp.js';
import { requireAdmin } from '../../middleware/auth.js';
import { loginLimiter, otpRequestLimiter, otpVerifyLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { emailProvider } from '../../providers/email/index.js';
import { logger } from '../../lib/logger.js';
import { invalidatePublicCaches } from '../public/cache.js';
import { isWithinIndia, OUTSIDE_INDIA_MESSAGE } from '../../lib/geo.js';
import { latestUnpublishReasons, SHOP_VIEWS, shopListState, shopViewWhere } from './shopViews.js';

import { computeFeeAccount } from '../fees/account.js';
import { UNPAID_STATEMENT_STATUSES } from '../fees/feeConfig.js';
import { afterBlockChange } from '../fees/enforcement.js';
import { emitFeeNotice } from '../fees/notices.js';

export const adminRouter = Router();

const dummyPasswordHash = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
const adminResetRequestSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();
const adminResetConfirmSchema = adminResetRequestSchema.extend({
  otp: z.string().regex(/^\d{6}$/),
  newPassword: z.string().min(12).max(128),
});
const ADMIN_RESET_TTL_MS = 15 * 60_000;
const ADMIN_RESET_RESEND_MS = 60_000;
const ADMIN_RESET_DAILY_LIMIT = 10;
const ADMIN_RESET_MAX_ATTEMPTS = 5;
const coordinatesSchema = z.object({
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)
    || (value.latitude != null) !== (value.longitude != null)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Latitude and longitude must be updated together' });
  }
  if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && !isWithinIndia(value.latitude, value.longitude)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: OUTSIDE_INDIA_MESSAGE });
  }
});
// "IIT  Delhi " and "IIT Delhi" are the same campus.
const campusNameSchema = z.string().trim().min(2).max(160).transform((value) => value.replace(/\s+/g, ' '));
const campusInputSchema = z.object({
  name: campusNameSchema,
  address: z.string().trim().min(3).max(300),
  slug: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
}).and(coordinatesSchema);
const campusPatchSchema = z.object({
  name: campusNameSchema.optional(),
  address: z.string().trim().min(3).max(300).optional(),
  slug: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)
    || (value.latitude != null) !== (value.longitude != null)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: 'Latitude and longitude must be updated together' });
  }
  if (typeof value.latitude === 'number' && typeof value.longitude === 'number' && !isWithinIndia(value.latitude, value.longitude)) {
    context.addIssue({ code: 'custom', path: ['latitude'], message: OUTSIDE_INDIA_MESSAGE });
  }
});
const reviewSchema = z.object({ notes: z.string().trim().max(2_000).optional() });
// Optional; older clients send no body at all.
const unpublishSchema = z.object({ reason: z.string().trim().max(500).optional() }).strict().optional();
const SHOP_PAGE_SIZE = 50;
const shopListQuerySchema = z.object({
  // 'fees' feeds the Platform fees section: only shops that owe money or are blocked.
  view: z.enum([...SHOP_VIEWS, 'fees']).default('all'),
  cursor: z.string().min(1).max(64).optional(),
});
const liftBlockSchema = z.object({
  reason: z.string().trim().min(10).max(500),
  // The evaluator will not re-block before the override ends.
  days: z.number().int().min(1).max(14).default(3),
}).strict();
const counterRefundSchema = z.object({
  studentConfirmed: z.literal(true),
  method: z.enum(['cash', 'shop_upi']),
  reason: z.string().trim().min(10).max(2_000),
  reference: z.string().trim().min(1).max(120).optional(),
}).strict();

function canonicalSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

async function uniqueCampusSlug(preferred: string, excludeId?: string): Promise<string> {
  const base = canonicalSlug(preferred) || 'campus';
  let slug = base;
  let existing = await prisma.campus.findUnique({ where: { slug }, select: { id: true } });
  for (let suffix = 2; existing && existing.id !== excludeId; suffix++) {
    slug = `${base.slice(0, Math.max(1, 100 - String(suffix).length - 1))}-${suffix}`;
    existing = await prisma.campus.findUnique({ where: { slug }, select: { id: true } });
  }
  return slug;
}

function audit(adminId: string, action: string, subjectType: string, subjectId: string, metadata?: object) {
  return { adminId, action, subjectType, subjectId, metadata: metadata ?? undefined };
}

/** Exact duplicates (ignoring case) confuse owners picking a campus, so refuse them. */
async function assertCampusNameFree(name: string, excludeId?: string): Promise<void> {
  const clash = await prisma.campus.findFirst({
    where: { name: { equals: name, mode: 'insensitive' }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
    select: { name: true, isActive: true },
  });
  if (!clash) return;
  throw conflict(clash.isActive
    ? `A campus called "${clash.name}" already exists.`
    : `A campus called "${clash.name}" already exists but is inactive. Activate it instead of adding it again.`);
}

/** Separately authenticated platform-admin login. Shop credentials cannot reach this route. */
adminRouter.post(
  '/auth/login',
  loginLimiter,
  validateBody(adminLoginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof adminLoginSchema>;
    const admin = await prisma.adminUser.findUnique({ where: { email } });
    const valid = await argon2.verify(admin?.passwordHash ?? dummyPasswordHash, password).catch(() => false);
    if (!admin || !admin.active || !valid) throw unauthorized('Invalid email or password');
    res.json({
      token: signAdminToken(admin.id, admin.sessionVersion),
      user: { id: admin.id, name: admin.name, role: admin.role },
    });
  }),
);

/** Separate admin recovery realm; always respond uniformly for unknown accounts. */
adminRouter.post(
  '/auth/request-reset',
  otpRequestLimiter,
  validateBody(adminResetRequestSchema),
  asyncHandler(async (req, res) => {
    const { email } = req.body as z.infer<typeof adminResetRequestSchema>;
    const admin = await prisma.adminUser.findUnique({ where: { email }, select: { id: true, active: true } });
    if (admin?.active) {
      const now = new Date();
      const recent = await prisma.adminPasswordResetOtp.findFirst({
        where: { adminId: admin.id, createdAt: { gt: new Date(now.getTime() - ADMIN_RESET_RESEND_MS) } },
        select: { id: true },
      });
      const sentToday = await prisma.adminPasswordResetOtp.count({
        where: { adminId: admin.id, createdAt: { gt: new Date(now.getTime() - 24 * 60 * 60_000) } },
      });
      if (!recent && sentToday < ADMIN_RESET_DAILY_LIMIT) {
        const otp = generateOtp();
        const reset = await prisma.adminPasswordResetOtp.create({
          data: { adminId: admin.id, otpHash: await hashOtp(otp), expiresAt: new Date(now.getTime() + ADMIN_RESET_TTL_MS) },
        });
        try {
          const delivered = await emailProvider.send(
            email,
            'Reset your PrintQs platform admin password',
            `Your PrintQs platform admin reset code is ${otp}. It expires in 15 minutes. If you did not request it, ignore this email.`,
          );
          await prisma.adminPasswordResetOtp.update({
            where: { id: reset.id },
            data: { deliveryProvider: emailProvider.name, deliveryMessageId: delivered.providerMessageId ?? null, deliveryAttemptedAt: new Date(), deliveryError: null },
          });
        } catch (error) {
          await prisma.adminPasswordResetOtp.update({
            where: { id: reset.id },
            data: { deliveryProvider: emailProvider.name, deliveryAttemptedAt: new Date(), deliveryError: error instanceof Error ? error.message.slice(0, 300) : 'Email delivery failed' },
          });
          logger.error({ resetId: reset.id, provider: emailProvider.name }, 'admin_password_reset_email_failed');
        }
      }
    }
    res.json({ ok: true });
  }),
);

adminRouter.post(
  '/auth/reset-password',
  otpVerifyLimiter,
  validateBody(adminResetConfirmSchema),
  asyncHandler(async (req, res) => {
    const { email, otp, newPassword } = req.body as z.infer<typeof adminResetConfirmSchema>;
    const admin = await prisma.adminUser.findUnique({ where: { email }, select: { id: true, active: true } });
    if (!admin?.active) throw badRequest('Code expired or not found — request a new one');
    const reset = await prisma.adminPasswordResetOtp.findFirst({
      where: { adminId: admin.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!reset) throw badRequest('Code expired or not found — request a new one');
    if (reset.attempts >= ADMIN_RESET_MAX_ATTEMPTS) throw badRequest('Too many wrong attempts — request a new code');
    if (!await verifyOtpHash(reset.otpHash, otp)) {
      await prisma.adminPasswordResetOtp.updateMany({
        where: { id: reset.id, consumedAt: null, attempts: { lt: ADMIN_RESET_MAX_ATTEMPTS } },
        data: { attempts: { increment: 1 } },
      });
      throw unauthorized('Incorrect code');
    }

    const passwordHash = await argon2.hash(newPassword, { type: argon2.argon2id });
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.adminPasswordResetOtp.updateMany({
        where: { id: reset.id, consumedAt: null, attempts: { lt: ADMIN_RESET_MAX_ATTEMPTS }, expiresAt: { gt: new Date() } },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1) throw badRequest('Code expired or already used');
      await tx.adminUser.update({ where: { id: admin.id }, data: { passwordHash, sessionVersion: { increment: 1 } } });
      await tx.adminAuditEvent.create({ data: audit(admin.id, 'admin_password_reset', 'admin_user', admin.id) });
    });
    res.json({ ok: true });
  }),
);

adminRouter.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const admin = await prisma.adminUser.findUnique({
      where: { id: req.admin!.id },
      select: { id: true, name: true, role: true, active: true },
    });
    if (!admin?.active) throw unauthorized();
    res.json({ user: admin });
  }),
);

/** Sign out: bumping sessionVersion makes requireAdmin refuse every token issued before now. */
adminRouter.post(
  '/auth/logout',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await prisma.adminUser.updateMany({
      where: { id: req.admin!.id },
      data: { sessionVersion: { increment: 1 } },
    });
    res.json({ ok: true });
  }),
);

/** The canonical campus catalogue. Deactivation hides all related shops from public discovery. */
adminRouter.get(
  '/campuses',
  requireAdmin,
  asyncHandler(async (_req, res) => {
    const campuses = await prisma.campus.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { shops: true } } },
    });
    res.json({ campuses });
  }),
);

adminRouter.post(
  '/campuses',
  requireAdmin,
  validateBody(campusInputSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof campusInputSchema>;
    await assertCampusNameFree(body.name);
    const slug = await uniqueCampusSlug(body.slug ?? body.name);
    const campus = await prisma.$transaction(async (tx) => {
      const created = await tx.campus.create({
        data: {
          slug,
          name: body.name,
          address: body.address,
          latitude: body.latitude ?? null,
          longitude: body.longitude ?? null,
          isActive: body.isActive ?? true,
        },
      });
      await tx.adminAuditEvent.create({
        data: audit(req.admin!.id, 'campus.created', 'campus', created.id, { active: created.isActive }),
      });
      return created;
    });
    invalidatePublicCaches();
    res.status(201).json({ campus });
  }),
);

adminRouter.patch(
  '/campuses/:id',
  requireAdmin,
  validateBody(campusPatchSchema),
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const body = req.body as z.infer<typeof campusPatchSchema>;
    const existing = await prisma.campus.findUnique({ where: { id } });
    if (!existing) throw notFound();
    if (body.name !== undefined) await assertCampusNameFree(body.name, id);
    const slug = body.slug === undefined ? undefined : await uniqueCampusSlug(body.slug, id);
    const campus = await prisma.$transaction(async (tx) => {
      const updated = await tx.campus.update({
        where: { id },
        data: { ...body, ...(slug ? { slug } : {}) },
      });
      await tx.adminAuditEvent.create({
        data: audit(req.admin!.id, 'campus.updated', 'campus', id, { active: updated.isActive, changed: Object.keys(body) }),
      });
      return updated;
    });
    // A rename or (de)activation changes public campus lists and hides/shows its shops.
    invalidatePublicCaches();
    res.json({ campus });
  }),
);

adminRouter.get(
  '/shops',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const parsed = shopListQuerySchema.safeParse(req.query);
    if (!parsed.success) throw badRequest('Unknown shop filter');
    const { view, cursor } = parsed.data;

    let where: Prisma.ShopWhereInput;
    if (view === 'fees') {
      // Shops with money still owed on a statement (a small set) or a fee block.
      const owing = await prisma.shopCommissionStatement.findMany({
        where: { status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 } },
        select: { shopId: true, amountDuePaise: true, paidPaise: true },
      });
      const owingIds = [...new Set(owing.filter((s) => s.amountDuePaise > s.paidPaise).map((s) => s.shopId))];
      where = { OR: [{ feeBlockedAt: { not: null } }, { id: { in: owingIds } }] };
    } else {
      where = shopViewWhere(view);
    }

    const [rows, all, live, hidden, setup] = await Promise.all([
      prisma.shop.findMany({
        where,
        // Newest first so fresh self-registrations are always on page one.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: SHOP_PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, slug: true, name: true, address: true, createdAt: true, autoLive: true,
          verificationStatus: true, verifiedAt: true, publishedAt: true, latitude: true, longitude: true,
          campus: { select: { name: true, isActive: true } },
          users: { where: { role: 'owner' }, orderBy: { createdAt: 'asc' }, take: 1, select: { name: true, email: true } },
          printers: { select: { osPrinterName: true } },
          agents: { select: { status: true, lastHeartbeatAt: true } },
          feeBlockedAt: true, feeBlockReason: true, feeBlockOverrideUntil: true,
        },
      }),
      prisma.shop.count(),
      prisma.shop.count({ where: shopViewWhere('live') }),
      prisma.shop.count({ where: shopViewWhere('hidden') }),
      prisma.shop.count({ where: shopViewWhere('setup') }),
    ]);
    const shops = rows.slice(0, SHOP_PAGE_SIZE);
    const nextCursor = rows.length > SHOP_PAGE_SIZE ? shops[shops.length - 1]!.id : null;

    // One query each for the listed shops' unpaid statements and unpublish reasons (no per-shop fan-out).
    const [unpaid, reasons] = await Promise.all([
      prisma.shopCommissionStatement.findMany({
        where: { shopId: { in: shops.map((s) => s.id) }, status: { in: UNPAID_STATEMENT_STATUSES }, amountDuePaise: { gt: 0 } },
        select: { shopId: true, amountDuePaise: true, paidPaise: true, dueAt: true },
      }),
      latestUnpublishReasons(shops.filter((s) => s.verificationStatus === 'verified' && !s.publishedAt).map((s) => s.id)),
    ]);
    const now = new Date();
    res.json({
      counts: { all, live, hidden, setup },
      nextCursor,
      shops: shops.map(({ users, printers, agents, latitude, longitude, ...shop }) => {
        const mine = unpaid.filter((s) => s.shopId === shop.id && s.amountDuePaise > s.paidPaise);
        const overdue = mine.filter((s) => s.dueAt && s.dueAt <= now);
        const heartbeats = agents.map((a) => a.lastHeartbeatAt?.getTime() ?? 0).filter(Boolean);
        let feeState: 'blocked' | 'overdue' | 'due' | 'paid_up' = 'paid_up';
        if (shop.feeBlockedAt) feeState = 'blocked';
        else if (overdue.length) feeState = 'overdue';
        else if (mine.length) feeState = 'due';
        return {
          ...shop,
          state: shopListState(shop),
          hiddenReason: reasons.get(shop.id) ?? null,
          owner: users[0] ?? null,
          setup: {
            location: latitude != null && longitude != null,
            printerLinked: printers.some((p) => p.osPrinterName),
            pcOnline: agents.some((a) => a.status === 'online'),
            pcCount: agents.length,
          },
          lastHeartbeatAt: heartbeats.length ? new Date(Math.max(...heartbeats)) : null,
          fees: {
            statementsDuePaise: mine.reduce((sum, s) => sum + s.amountDuePaise - s.paidPaise, 0),
            overdueStatements: overdue.length,
            overduePaise: overdue.reduce((sum, s) => sum + s.amountDuePaise - s.paidPaise, 0),
            state: feeState,
          },
        };
      }),
    });
  }),
);

/** Fee detail for one shop: statements, payments and the support block history. */
adminRouter.get(
  '/shops/:id/fees',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const shop = await prisma.shop.findUnique({
      where: { id },
      select: { id: true, name: true, feeBlockedAt: true, feeBlockReason: true, feeBlockOverrideUntil: true },
    });
    if (!shop) throw notFound();
    const [account, payments, events] = await Promise.all([
      computeFeeAccount(prisma, id),
      prisma.shopFeePayment.findMany({
        where: { shopId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, amountPaise: true, status: true, providerPaymentId: true, paidAt: true, createdAt: true },
      }),
      prisma.shopFeeEvent.findMany({ where: { shopId: id }, orderBy: { createdAt: 'desc' }, take: 30 }),
    ]);
    res.json({ shop, fees: { ...account, payments, events } });
  }),
);

/**
 * Support override for a fee block (e.g. payment made outside the app). The
 * reason is mandatory and audited; the evaluator will not re-block until the
 * override window ends. It does not forgive the statements.
 */
adminRouter.post(
  '/shops/:id/fees/lift-block',
  requireAdmin,
  validateBody(liftBlockSchema),
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const { reason, days } = req.body as z.infer<typeof liftBlockSchema>;
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${id} FOR UPDATE`;
      const shop = await tx.shop.findUnique({ where: { id }, select: { feeBlockedAt: true } });
      if (!shop) throw notFound();
      if (!shop.feeBlockedAt) throw conflict('This shop is not blocked');
      const until = new Date(now.getTime() + days * 86_400_000);
      await tx.shop.update({
        where: { id },
        data: { feeBlockedAt: null, feeBlockReason: null, feeBlockOverrideUntil: until },
      });
      await tx.shopFeeEvent.create({ data: { shopId: id, kind: 'block_lifted_by_admin', metadata: { days, adminId: req.admin!.id } } });
      const event = await tx.adminAuditEvent.create({
        data: audit(req.admin!.id, 'shop.fee_block_lifted', 'shop', id, { reason, days }),
      });
      return { until, auditId: event.id };
    });
    await afterBlockChange(id, { change: 'unblocked' });
    await emitFeeNotice({
      shopId: id,
      kind: 'unblocked',
      dedupeKey: `lift-${result.auditId}`,
      title: 'Your PrintQs shop is open again',
      body: 'Our support team has reopened your shop for new orders. Please clear any pending PrintQs fee from the Earnings page.',
    }).catch((error) => logger.error({ error }, 'fee_lift_notice_failed'));
    res.json({ ok: true, overrideUntil: result.until });
  }),
);

adminRouter.post(
  '/shops/:id/verify',
  requireAdmin,
  validateBody(reviewSchema),
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const notes = (req.body as z.infer<typeof reviewSchema>).notes;
    const shop = await prisma.shop.findUnique({ where: { id }, include: { campus: true } });
    if (!shop) throw notFound();
    if (shop.verificationStatus !== 'submitted') throw conflict('Only submitted shops can be verified');
    if ((shop.campus && !shop.campus.isActive) || shop.latitude == null || shop.longitude == null) {
      throw conflict('The shop is on an inactive campus or has no complete location');
    }
    const verified = await prisma.$transaction(async (tx) => {
      const updated = await tx.shop.update({
        where: { id },
        data: { verificationStatus: 'verified', verifiedAt: new Date(), publishedAt: null, verificationNotes: notes ?? null },
        select: { id: true, verificationStatus: true, verifiedAt: true, publishedAt: true },
      });
      await tx.adminAuditEvent.create({ data: audit(req.admin!.id, 'shop.verified', 'shop', id) });
      return updated;
    });
    res.json({ shop: verified });
  }),
);

adminRouter.post(
  '/shops/:id/reject',
  requireAdmin,
  validateBody(reviewSchema),
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const notes = (req.body as z.infer<typeof reviewSchema>).notes;
    const shop = await prisma.shop.findUnique({ where: { id }, select: { id: true, verificationStatus: true } });
    if (!shop) throw notFound();
    if (shop.verificationStatus === 'draft') throw conflict('A draft shop has not requested verification');
    const rejected = await prisma.$transaction(async (tx) => {
      const updated = await tx.shop.update({
        where: { id },
        data: { verificationStatus: 'rejected', verifiedAt: null, publishedAt: null, verificationNotes: notes ?? null },
        select: { id: true, verificationStatus: true, verifiedAt: true, publishedAt: true },
      });
      await tx.adminAuditEvent.create({ data: audit(req.admin!.id, 'shop.rejected', 'shop', id) });
      return updated;
    });
    invalidatePublicCaches();
    res.json({ shop: rejected });
  }),
);

adminRouter.post(
  '/shops/:id/publish',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const shop = await prisma.shop.findUnique({ where: { id }, include: { campus: true } });
    if (!shop) throw notFound();
    if (shop.verificationStatus !== 'verified' || (shop.campus && !shop.campus.isActive)) {
      throw conflict('Only verified shops that are not on an inactive campus can be published');
    }
    const published = await prisma.$transaction(async (tx) => {
      const updated = await tx.shop.update({
        where: { id },
        data: { publishedAt: new Date() },
        select: { id: true, verificationStatus: true, publishedAt: true },
      });
      await tx.adminAuditEvent.create({ data: audit(req.admin!.id, 'shop.published', 'shop', id) });
      return updated;
    });
    invalidatePublicCaches();
    res.json({ shop: published });
  }),
);

adminRouter.post(
  '/shops/:id/unpublish',
  requireAdmin,
  validateBody(unpublishSchema),
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    // The optional reason lives in the audit event (metadata.reason); see latestUnpublishReasons.
    const reason = (req.body as z.infer<typeof unpublishSchema>)?.reason || undefined;
    const shop = await prisma.shop.findUnique({ where: { id }, select: { id: true } });
    if (!shop) throw notFound();
    const unpublished = await prisma.$transaction(async (tx) => {
      const updated = await tx.shop.update({
        where: { id },
        data: { publishedAt: null },
        select: { id: true, verificationStatus: true, publishedAt: true },
      });
      await tx.adminAuditEvent.create({ data: audit(req.admin!.id, 'shop.unpublished', 'shop', id, reason ? { reason } : undefined) });
      return updated;
    });
    invalidatePublicCaches();
    res.json({ shop: unpublished });
  }),
);

/**
 * Record a support-confirmed full counter-payment refund after a printed job.
 * The support/admin operator must verify the student and actual return. This
 * route does not move funds; it freezes the audit evidence and reverses the
 * single PrintQs receivable in the authoritative PostgreSQL ledger.
 */
adminRouter.post(
  '/jobs/:id/confirm-counter-refund',
  requireAdmin,
  validateBody(counterRefundSchema),
  asyncHandler(async (req, res) => {
    const jobId = param(req, 'id');
    const { studentConfirmed, method, reason, reference } = req.body as z.infer<typeof counterRefundSchema>;
    if (!studentConfirmed) throw badRequest('Student/support confirmation is required');

    const result = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Job" WHERE "id" = ${jobId} FOR UPDATE`;
      const job = await tx.job.findUnique({ where: { id: jobId } });
      if (!job) throw notFound();
      if (job.paymentProvider !== 'pay_at_shop' || job.paymentStatus !== 'paid' || !job.counterPaymentConfirmedAt) {
        throw conflict('Only a staff-confirmed pay-at-shop order can be refunded here');
      }
      if (!job.printConfirmedAt || !['finishing', 'ready_for_pickup', 'completed'].includes(job.status)) {
        throw conflict('This support refund route is for a physically printed order; failed unprinted orders use the counter-return action');
      }
      if (job.refundConfirmedAt) throw conflict('A refund has already been recorded');
      const commission = await tx.shopCommissionEntry.findUnique({
        where: { jobId_type: { jobId, type: 'print_commission' } },
      });
      if (!commission) throw conflict('The completed-print commission entry is missing; reconcile it before refunding');

      const now = new Date();
      await tx.job.update({
        where: { id: jobId },
        data: {
          paymentStatus: 'refunded',
          refundConfirmedAt: now,
          refundConfirmedByAdminId: req.admin!.id,
          refundAmountPaise: job.counterPaymentAmountPaise ?? job.totalPaise,
          refundReason: reason,
          refundReference: reference ?? null,
        },
      });
      await tx.shopCommissionEntry.create({
        data: {
          shopId: job.shopId,
          jobId,
          type: 'refund_credit',
          amountPaise: -commission.amountPaise,
          description: 'Support-confirmed full student refund; commission receivable reversed',
        },
      });
      await tx.paymentEvent.create({
        data: {
          provider: 'pay_at_shop',
          providerEventId: `counter_refund_${jobId}`,
          jobId,
          payload: {
            confirmedByAdminId: req.admin!.id,
            returnedByMethod: method,
            amountPaise: job.counterPaymentAmountPaise ?? job.totalPaise,
            reason,
            reference: reference ?? null,
          },
        },
      });
      await tx.adminAuditEvent.create({
        data: audit(req.admin!.id, 'job.counter_payment_refunded', 'job', jobId, {
          shopId: job.shopId,
          amountPaise: job.counterPaymentAmountPaise ?? job.totalPaise,
          method,
          reference: reference ?? null,
          reason,
          reversedCommissionPaise: commission.amountPaise,
        }),
      });
      return { jobId, paymentStatus: 'refunded' as const };
    }, { isolationLevel: 'Serializable' });

    res.json({ ok: true, job: result });
  }),
);

/** Read-only audit export for operational review; the application has no update/delete route. */
adminRouter.get(
  '/audit-events',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 100;
    const take = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 100;
    const events = await prisma.adminAuditEvent.findMany({
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, action: true, subjectType: true, subjectId: true, metadata: true, createdAt: true,
        admin: { select: { id: true, name: true } },
      },
    });
    // Name the shop/campus each entry is about, so the trail is readable.
    const idsOf = (type: string) => [...new Set(events.filter((e) => e.subjectType === type).map((e) => e.subjectId))];
    const shopIds = idsOf('shop');
    const campusIds = idsOf('campus');
    const [shops, campuses] = await Promise.all([
      shopIds.length ? prisma.shop.findMany({ where: { id: { in: shopIds } }, select: { id: true, name: true } }) : [],
      campusIds.length ? prisma.campus.findMany({ where: { id: { in: campusIds } }, select: { id: true, name: true } }) : [],
    ]);
    const names = new Map([...shops, ...campuses].map((s) => [s.id, s.name]));
    res.json({ events: events.map((e) => ({ ...e, subjectName: names.get(e.subjectId) ?? null })) });
  }),
);
