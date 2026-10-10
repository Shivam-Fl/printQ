import { prisma } from './prisma.js';
import type { ShopClaims } from './tokens.js';

export interface ShopSession {
  id: string;
  shopId: string;
  role: 'owner' | 'staff';
}

/**
 * A shop JWT is only a claim: the account must still exist in the claimed shop
 * and the token must carry the account's current session version. One primary-
 * key lookup; deliberately uncached so deleting staff or signing out takes
 * effect on the very next request. Role comes from the row, not the token.
 */
export async function resolveShopSession(claims: ShopClaims): Promise<ShopSession | null> {
  const user = await prisma.shopUser.findFirst({
    where: { id: claims.sub, shopId: claims.shopId },
    select: { id: true, shopId: true, role: true, sessionVersion: true },
  });
  if (!user || user.sessionVersion !== claims.sv) return null;
  return { id: user.id, shopId: user.shopId, role: user.role };
}
