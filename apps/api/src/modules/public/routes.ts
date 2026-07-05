import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';

export const publicRouter = Router();

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
        rateCard: true,
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
    res.json({
      shop: {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campusName,
        rateCard: shop.rateCard,
        open: online.length > 0,
        capabilities: {
          paperSizes: [...new Set(online.flatMap((p) => p.paperSizesLoaded))],
          color: online.some((p) => p.colorSupport),
          finishingOptions: [...new Set(online.flatMap((p) => p.finishingOptions))],
        },
      },
    });
  }),
);
