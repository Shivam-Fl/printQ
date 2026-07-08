// one-off: insert test coupons directly via Prisma for scripts/proof-phase4.mjs
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
await prisma.coupon.upsert({
  where: { code: 'PROOF10' },
  create: { code: 'PROOF10', percentOff: 10 },
  update: { percentOff: 10, paiseOff: null, expiresAt: null, maxRedemptions: null, redeemedCount: 0 },
});
await prisma.coupon.upsert({
  where: { code: 'PROOFEXPIRED' },
  create: { code: 'PROOFEXPIRED', percentOff: 50, expiresAt: new Date(Date.now() - 60_000) },
  update: { expiresAt: new Date(Date.now() - 60_000), redeemedCount: 0 },
});
await prisma.coupon.upsert({
  where: { code: 'PROOFMAXED' },
  create: { code: 'PROOFMAXED', percentOff: 50, maxRedemptions: 1, redeemedCount: 1 },
  update: { maxRedemptions: 1, redeemedCount: 1 },
});
console.log('coupons seeded');
await prisma.$disconnect();
