import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { shopOptions } from '../../lib/shopOptions.js';

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

    res.json({
      shop: {
        slug: shop.slug,
        name: shop.name,
        address: shop.address,
        campusName: shop.campusName,
        open: online.length > 0,
        colorAvailable,
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
