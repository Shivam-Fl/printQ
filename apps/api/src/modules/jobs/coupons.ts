import type { ResolvedCoupon } from '@printq/shared';
import { prisma } from '../../lib/prisma.js';
import { badRequest } from '../../lib/errors.js';

/**
 * Looks up a coupon code and validates it's usable for this shop right now:
 * exists, not expired, redemption limit not hit, and either platform-wide or
 * scoped to this specific shop. Throws a client-safe error on any failure.
 */
export async function resolveCoupon(code: string, shopId: string): Promise<ResolvedCoupon> {
  const coupon = await prisma.coupon.findUnique({ where: { code: code.trim().toUpperCase() } });
  if (!coupon) throw badRequest('Invalid coupon code');
  if (coupon.shopId && coupon.shopId !== shopId) throw badRequest('This coupon isn\'t valid at this shop');
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) throw badRequest('This coupon has expired');
  if (coupon.maxRedemptions != null && coupon.redeemedCount >= coupon.maxRedemptions) {
    throw badRequest('This coupon has already been fully redeemed');
  }
  return { code: coupon.code, percentOff: coupon.percentOff, paiseOff: coupon.paiseOff };
}

/** Best-effort redemption increment — called once a job using the coupon is actually created. */
export async function redeemCoupon(code: string): Promise<void> {
  await prisma.coupon.update({
    where: { code: code.trim().toUpperCase() },
    data: { redeemedCount: { increment: 1 } },
  });
}
