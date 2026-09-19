import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireStudent } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { shopOptions } from '../../lib/shopOptions.js';
import { isShopOperational, reachablePrinterIds } from '../shops/availability.js';
import { canShopAcceptCash } from '../earnings/service.js';
import { nearbyShops, publishedShopWhere } from './discovery.js';

export const publicRouter = Router();

/** Canonical, platform-curated campus choices for search and shop onboarding. */
publicRouter.get(
  '/campuses',
  asyncHandler(async (_req, res) => {
    const campuses = await prisma.campus.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, slug: true, name: true, address: true },
      take: 200,
    });
    res.json({ campuses });
  }),
);

/** Only independently verified, explicitly published shops on active campuses are discoverable. */
publicRouter.get(
  '/shops',
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const shops = await prisma.shop.findMany({
      where: {
        AND: [
          publishedShopWhere,
          ...(q
            ? [{
                OR: [
                  { name: { contains: q, mode: 'insensitive' as const } },
                  { campus: { is: { name: { contains: q, mode: 'insensitive' as const } } } },
                  { address: { contains: q, mode: 'insensitive' as const } },
                ],
              }]
            : []),
        ],
      },
      orderBy: { name: 'asc' },
      take: 20,
      select: {
        id: true,
        slug: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
        acceptingOrders: true,
        campus: { select: { name: true } },
        cashPaymentsEnabled: true,
        printers: { select: { id: true, status: true } },
        agents: { select: { status: true, connectedPrinterIds: true } },
      },
    });
    res.json({
      shops: shops.map((shop) => {
        const reachable = new Set(
          shop.agents.filter((agent) => agent.status === 'online').flatMap((agent) => agent.connectedPrinterIds),
        );
        return {
          slug: shop.slug,
          name: shop.name,
          campusName: shop.campus!.name,
          address: shop.address,
          open: shop.acceptingOrders
            && shop.latitude != null
            && shop.longitude != null
            && shop.printers.some((printer) => printer.status === 'online' && reachable.has(printer.id)),
        };
      }),
    });
  }),
);

/**
 * One-request location lookup. The browser calls this only after a user
 * gesture; location never enters a URL, database record, event, or log.
 */
publicRouter.post(
  '/shops/nearby',
  validateBody(z.object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    maxDistanceM: z.number().int().min(100).max(20_000).default(5_000),
  })),
  asyncHandler(async (req, res) => {
    const { latitude, longitude, maxDistanceM } = req.body as {
      latitude: number;
      longitude: number;
      maxDistanceM: number;
    };
    const shops = await prisma.shop.findMany({
      where: publishedShopWhere,
      // A launch-scale bounded candidate pool, then an exact great-circle
      // calculation. Move this to a PostGIS/geography index before operating
      // a nationwide directory; no caller coordinates are persisted either way.
      take: 250,
      orderBy: { publishedAt: 'desc' },
      select: {
        slug: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
        acceptingOrders: true,
        campus: { select: { name: true } },
        printers: { select: { id: true, status: true } },
        agents: { select: { status: true, connectedPrinterIds: true } },
      },
    });
    const candidates = shops.map((shop) => {
      const reachable = new Set(
        shop.agents.filter((agent) => agent.status === 'online').flatMap((agent) => agent.connectedPrinterIds),
      );
      return {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campus!.name,
        latitude: shop.latitude,
        longitude: shop.longitude,
        open: shop.acceptingOrders
          && shop.latitude != null
          && shop.longitude != null
          && shop.printers.some((printer) => printer.status === 'online' && reachable.has(printer.id)),
      };
    });
    res.json({ shops: nearbyShops({ latitude, longitude }, candidates, maxDistanceM) });
  }),
);

/**
 * Public shop landing data (QR code target): name and capabilities.
 * The owner's private base rate card is deliberately never returned here.
 * No auth — contains nothing user-scoped.
 */
publicRouter.get(
  '/shops/:slug',
  asyncHandler(async (req, res) => {
    const shop = await prisma.shop.findFirst({
      where: { slug: param(req, 'slug'), ...publishedShopWhere },
      select: {
        id: true,
        slug: true,
        name: true,
        address: true,
        campus: { select: { name: true } },
        latitude: true,
        longitude: true,
        acceptingOrders: true,
        cashPaymentsEnabled: true,
        printOptions: true,
        printers: {
          select: {
            id: true,
            paperSizesLoaded: true,
            colorSupport: true,
            finishingOptions: true,
            status: true,
          },
        },
      },
    });
    if (!shop) throw notFound();

    const reachable = await reachablePrinterIds(shop.id);
    const online = shop.printers.filter((p) => p.status === 'online' && reachable.has(p.id));
    const options = shopOptions(shop);
    // only surface options at least one online printer can actually produce
    const loadedPapers = new Set(online.flatMap((p) => p.paperSizesLoaded));
    const loadedBindings = new Set(online.flatMap((p) => p.finishingOptions));
    const colorAvailable = online.some((p) => p.colorSupport);

    const [ratingAgg, cashWithinLimit] = await Promise.all([
      prisma.job.aggregate({
        where: { shopId: shop.id, rating: { not: null } },
        _avg: { rating: true },
        _count: { rating: true },
      }),
      shop.cashPaymentsEnabled ? canShopAcceptCash(shop.id) : Promise.resolve(false),
    ]);

    res.json({
      shop: {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campus!.name,
        open: shop.acceptingOrders && shop.latitude != null && shop.longitude != null && online.length > 0,
        cashPaymentsEnabled: shop.cashPaymentsEnabled && cashWithinLimit,
        colorAvailable,
        rating: {
          average: ratingAgg._avg.rating != null ? Math.round(ratingAgg._avg.rating * 10) / 10 : null,
          count: ratingAgg._count.rating,
        },
        options: {
          papers: options.papers
            .filter((p) => loadedPapers.size === 0 || loadedPapers.has(p.id))
            .map((p) => ({
              id: p.id,
              label: p.label,
              colorAvailable: colorAvailable && p.colorPaise != null,
            })),
          bindings: options.bindings
            .filter((b) => loadedBindings.size === 0 || loadedBindings.has(b.id))
            .map((b) => ({ id: b.id, label: b.label })),
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
    const shop = await prisma.shop.findFirst({
      where: { slug: param(req, 'slug'), ...publishedShopWhere },
      select: { id: true, printers: { select: { status: true } } },
    });
    if (!shop) throw notFound();

    const alreadyOpen = await isShopOperational(shop.id);
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
