import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireStudent } from '../../middleware/auth.js';
import { shopOptions } from '../../lib/shopOptions.js';

export const publicRouter = Router();

/** Shop directory — simple name/campus text search, no geo/maps. */
publicRouter.get(
  '/shops',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const shops = await prisma.shop.findMany({
      where: q
        ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { campusName: { contains: q, mode: 'insensitive' } }] }
        : {},
      orderBy: { name: 'asc' },
      take: 20,
      select: { slug: true, name: true, campusName: true, address: true },
    });
    res.json({ shops });
  }),
);

/**
 * Public shop landing data (QR code target): name, prices, capabilities.
 * No auth — contains nothing user-scoped.
 */
publicRouter.get(
  '/shops/:slug',
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.findUnique({
      where: { slug: param(req, 'slug') },
      select: {
        id: true,
        slug: true,
        name: true,
        address: true,
        campusName: true,
        printOptions: true,
        printers: {
          select: {
            paperSizesLoaded: true,
            colorSupport: true,
            finishingOptions: true,
            status: true,
          },
        },
      },
    });
    if (!shop) throw notFound();

    const online = shop.printers.filter((p) => p.status === 'online');
    const options = shopOptions(shop);
    // only surface options at least one online printer can actually produce
    const loadedPapers = new Set(online.flatMap((p) => p.paperSizesLoaded));
    const loadedBindings = new Set(online.flatMap((p) => p.finishingOptions));
    const colorAvailable = online.some((p) => p.colorSupport);

    const ratingAgg = await prisma.job.aggregate({
      where: { shopId: shop.id, rating: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    res.json({
      shop: {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campusName,
        open: online.length > 0,
        colorAvailable,
        rating: {
          average: ratingAgg._avg.rating != null ? Math.round(ratingAgg._avg.rating * 10) / 10 : null,
          count: ratingAgg._count.rating,
        },
        options: {
          papers: options.papers
            .filter((p) => loadedPapers.size === 0 || loadedPapers.has(p.id))
            .map((p) => ({ ...p, colorPaise: colorAvailable ? p.colorPaise : null })),
          bindings: options.bindings.filter((b) => loadedBindings.size === 0 || loadedBindings.has(b.id)),
          duplexEnabled: options.duplexEnabled,
        },
      },
    });
  }),
);

/** A student asks to be pinged (Web Push) when a currently-closed shop has a printer online again. */
publicRouter.post(
  '/shops/:slug/notify-when-open',
  requireStudent,
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.findUnique({
      where: { slug: param(req, 'slug') },
      select: { id: true, printers: { select: { status: true } } },
    });
    if (!shop) throw notFound();

    const alreadyOpen = shop.printers.some((p) => p.status === 'online');
    if (alreadyOpen) {
      res.json({ ok: true, alreadyOpen: true });
      return;
    }

    await prisma.shopOpenInterest.upsert({
      where: { shopId_studentId: { shopId: shop.id, studentId: req.student!.id } },
      create: { shopId: shop.id, studentId: req.student!.id },
      update: {},
    });
    res.json({ ok: true, alreadyOpen: false });
  }),
);
