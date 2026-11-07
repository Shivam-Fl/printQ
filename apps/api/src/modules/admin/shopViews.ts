import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { publishedShopWhere } from '../public/discovery.js';

/**
 * Admin console filter tabs. They split every shop into exactly one group:
 * live (what students see, same rule as public discovery), hidden (reviewed
 * but not visible: unpublished, rejected or on a switched-off campus) and
 * setup (never reviewed: still setting up or waiting for a manual review).
 */
export const SHOP_VIEWS = ['all', 'live', 'hidden', 'setup'] as const;
export type ShopView = (typeof SHOP_VIEWS)[number];

export function shopViewWhere(view: ShopView): Prisma.ShopWhereInput {
  switch (view) {
    case 'live':
      return publishedShopWhere;
    case 'hidden':
      return {
        OR: [
          { verificationStatus: 'rejected' },
          { verificationStatus: 'verified', publishedAt: null },
          { verificationStatus: 'verified', campus: { is: { isActive: false } } },
        ],
      };
    case 'setup':
      return { verificationStatus: { in: ['draft', 'submitted'] } };
    default:
      return {};
  }
}

export type ShopListState =
  | 'live'
  | 'campus_inactive'
  | 'hidden_by_admin'
  | 'rejected'
  | 'waiting_review'
  | 'setting_up';

/** The one-word state the console shows on a row; mirrors shopViewWhere. */
export function shopListState(shop: {
  verificationStatus: 'draft' | 'submitted' | 'verified' | 'rejected';
  publishedAt: Date | null;
  campus: { isActive: boolean } | null;
}): ShopListState {
  if (shop.verificationStatus === 'draft') return 'setting_up';
  if (shop.verificationStatus === 'submitted') return 'waiting_review';
  if (shop.verificationStatus === 'rejected') return 'rejected';
  if (!shop.publishedAt) return 'hidden_by_admin';
  if (shop.campus && !shop.campus.isActive) return 'campus_inactive';
  return 'live';
}

/**
 * The reason typed by the admin on each shop's most recent unpublish (null
 * when none was given). Stored in AdminAuditEvent.metadata.reason, action
 * 'shop.unpublished', so no extra column is needed.
 */
export async function latestUnpublishReasons(shopIds: string[]): Promise<Map<string, string | null>> {
  const reasons = new Map<string, string | null>();
  if (shopIds.length === 0) return reasons;
  const events = await prisma.adminAuditEvent.findMany({
    where: { action: 'shop.unpublished', subjectType: 'shop', subjectId: { in: shopIds } },
    orderBy: { createdAt: 'desc' },
    select: { subjectId: true, metadata: true },
  });
  for (const event of events) {
    if (reasons.has(event.subjectId)) continue;
    const reason = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata)
      ? (event.metadata as Record<string, unknown>).reason
      : undefined;
    reasons.set(event.subjectId, typeof reason === 'string' && reason ? reason : null);
  }
  return reasons;
}
