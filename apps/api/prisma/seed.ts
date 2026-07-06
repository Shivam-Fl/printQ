/**
 * Dev/pilot seed: one demo shop, an owner login, two printers.
 * Idempotent — safe to run repeatedly.
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { DEFAULT_PRINT_OPTIONS } from '@printq/shared';

const prisma = new PrismaClient();

const OWNER_EMAIL = 'owner@demo.printq.local';
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD ?? 'demo-owner-pass-1';

async function main() {
  const shop = await prisma.shop.upsert({
    where: { slug: 'demo' },
    update: {},
    create: {
      slug: 'demo',
      name: 'Demo Xerox Point',
      address: 'Gate 2, Demo College Road',
      campusName: 'Demo College',
      autoAssignEnabled: true,
      rateCard: {}, // legacy column, superseded by printOptions
      printOptions: DEFAULT_PRINT_OPTIONS as unknown as object,
    },
  });

  await prisma.shopUser.upsert({
    where: { email: OWNER_EMAIL },
    update: {},
    create: {
      shopId: shop.id,
      email: OWNER_EMAIL,
      passwordHash: await argon2.hash(OWNER_PASSWORD, { type: argon2.argon2id }),
      name: 'Demo Owner',
      role: 'owner',
    },
  });

  const printerCount = await prisma.printer.count({ where: { shopId: shop.id } });
  if (printerCount === 0) {
    await prisma.printer.createMany({
      data: [
        {
          shopId: shop.id,
          label: 'Printer 1 — B/W near entrance',
          paperSizesLoaded: ['A4'],
          colorSupport: false,
          finishingOptions: ['stapling'],
          avgPagesPerMinute: 25,
          status: 'online',
        },
        {
          shopId: shop.id,
          label: 'Printer 2 — Color',
          paperSizesLoaded: ['A4', 'A3'],
          colorSupport: true,
          finishingOptions: ['stapling', 'spiral_binding'],
          avgPagesPerMinute: 12,
          status: 'online',
        },
      ],
    });
  }

  console.log('Seeded demo shop:');
  console.log(`  student page:  /s/demo`);
  console.log(`  dashboard:     ${OWNER_EMAIL} / ${OWNER_PASSWORD}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
