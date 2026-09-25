import { Router } from 'express';
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
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)
    || (value.latitude != null) !== (value.longitude != null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['latitude'], message: 'Latitude and longitude must be updated together' });
  }
});
const campusInputSchema = z.object({
  name: z.string().trim().min(2).max(160),
  address: z.string().trim().min(3).max(300),
  slug: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
}).and(coordinatesSchema);
const campusPatchSchema = z.object({
  name: z.string().trim().min(2).max(160).optional(),
  address: z.string().trim().min(3).max(300).optional(),
  slug: z.string().trim().min(2).max(120).optional(),
  isActive: z.boolean().optional(),
  latitude: z.number().finite().min(-90).max(90).nullable().optional(),
  longitude: z.number().finite().min(-180).max(180).nullable().optional(),
}).superRefine((value, context) => {
  if ((value.latitude === undefined) !== (value.longitude === undefined)
    || (value.latitude != null) !== (value.longitude != null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['latitude'], message: 'Latitude and longitude must be updated together' });
  }
});
const reviewSchema = z.object({ notes: z.string().trim().max(2_000).optional() });
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
    const slug = body.slug === undefined ? undefined : await uniqueCampusSlug(body.slug, id);
    const campus = await prisma.$transaction(async (tx) => {
      const updated = await tx.campus.update({
        where: { id },
        data: { ...body, ...(slug ? { slug } : {}) },
      });
      await tx.adminAuditEvent.create({
        data: audit(req.admin!.id, 'campus.updated', 'campus', id, { active: updated.isActive }),
      });
      return updated;
    });
    res.json({ campus });
  }),
);

adminRouter.get(
  '/shops',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    if (status && !['draft', 'submitted', 'verified', 'rejected'].includes(status)) throw badRequest('Unknown verification status');
    const shops = await prisma.shop.findMany({
      where: status ? { verificationStatus: status as 'draft' | 'submitted' | 'verified' | 'rejected' } : undefined,
      orderBy: [{ verificationSubmittedAt: 'asc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        id: true, slug: true, name: true, address: true, campusId: true,
        verificationStatus: true, verificationSubmittedAt: true, verifiedAt: true, publishedAt: true,
        campus: { select: { name: true, isActive: true } },
        printers: { select: { id: true, status: true, osPrinterName: true } },
        agents: { select: { id: true, status: true } },
      },
    });
    res.json({ shops });
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
    if (!shop.campus?.isActive || shop.latitude == null || shop.longitude == null) {
      throw conflict('The shop no longer has an active campus and complete location');
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
    if (shop.verificationStatus !== 'verified' || !shop.campus?.isActive) {
      throw conflict('Only verified shops on active campuses can be published');
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
    res.json({ shop: published });
  }),
);

adminRouter.post(
  '/shops/:id/unpublish',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = param(req, 'id');
    const shop = await prisma.shop.findUnique({ where: { id }, select: { id: true } });
    if (!shop) throw notFound();
    const unpublished = await prisma.$transaction(async (tx) => {
      const updated = await tx.shop.update({
        where: { id },
        data: { publishedAt: null },
        select: { id: true, verificationStatus: true, publishedAt: true },
      });
      await tx.adminAuditEvent.create({ data: audit(req.admin!.id, 'shop.unpublished', 'shop', id) });
      return updated;
    });
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
    res.json({ events });
  }),
);
