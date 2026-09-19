import { Router } from 'express';
import argon2 from 'argon2';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { signAdminToken } from '../../lib/tokens.js';
import { requireAdmin } from '../../middleware/auth.js';
import { loginLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';

export const adminRouter = Router();

const dummyPasswordHash = '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const adminLoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(128),
});
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
      token: signAdminToken(admin.id),
      user: { id: admin.id, name: admin.name, role: admin.role },
    });
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
