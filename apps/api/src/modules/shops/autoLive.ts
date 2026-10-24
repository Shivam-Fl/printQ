import { prisma } from '../../lib/prisma.js';
import { shopOptions } from '../../lib/shopOptions.js';
import { invalidatePublicCaches } from '../public/cache.js';

/**
 * Owner-approved rule: a NEW shop (autoLive) goes live by itself once it has a
 * location, a print menu, a linked printer and an online agent connected to a
 * linked printer. Only never-reviewed shops (verificationStatus draft, or submitted by an older client) are
 * touched: an admin rejection or unpublish is final until an admin acts, and
 * shops that existed before this rule (autoLive=false) keep manual verification.
 * Returns true when the shop was published by this call.
 */
export async function publishIfReady(shopId: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    include: { printers: true, agents: true },
  });
  if (!shop || !shop.autoLive || (shop.verificationStatus !== 'draft' && shop.verificationStatus !== 'submitted') || shop.publishedAt) return false;

  const linkedOnline = new Set(
    shop.printers.filter((p) => p.osPrinterName && p.status === 'online').map((p) => p.id),
  );
  const ready = shop.latitude != null && shop.longitude != null
    && shopOptions(shop).papers.length > 0
    && shop.agents.some((a) => a.status === 'online' && a.connectedPrinterIds.some((id) => linkedOnline.has(id)));
  if (!ready) return false;

  const now = new Date();
  const result = await prisma.shop.updateMany({
    // guard against racing an admin action
    where: { id: shopId, autoLive: true, verificationStatus: { in: ['draft', 'submitted'] }, publishedAt: null },
    data: { verificationStatus: 'verified', verificationSubmittedAt: now, verifiedAt: now, publishedAt: now },
  });
  if (result.count > 0) invalidatePublicCaches();
  return result.count > 0;
}
