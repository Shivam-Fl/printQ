// Local QA seed (never committed): verified+published shop, student with jobs in several states, tokens file.
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';
import { DEFAULT_PRINT_OPTIONS } from '@printq/shared';
import { signShopToken, signStudentToken } from '../src/lib/tokens.js';
import { digestReleaseCode, encryptReleaseCode } from '../src/lib/otp.js';

const prisma = new PrismaClient();
const LONG = 'Supercalifragilisticexpialidocious_' + 'A'.repeat(70);

const shop = await prisma.shop.upsert({
  where: { slug: 'demo' },
  update: {},
  create: {
    slug: 'demo', name: `Demo Xerox ${LONG}`, address: `Gate 2 ${'B'.repeat(80)}`, campusName: 'Demo College',
    latitude: 28.6139, longitude: 77.209, autoAssignEnabled: true, rateCard: {},
    printOptions: DEFAULT_PRINT_OPTIONS as unknown as object,
    verificationStatus: 'verified', verifiedAt: new Date(), verificationSubmittedAt: new Date(), publishedAt: new Date(),
  },
});
const owner = await prisma.shopUser.upsert({
  where: { email: 'owner@demo.printq.local' }, update: {},
  create: { shopId: shop.id, email: 'owner@demo.printq.local', name: `Owner ${LONG}`, role: 'owner', passwordHash: await argon2.hash('demo-owner-pass-1', { type: argon2.argon2id }) },
});
const printer = (await prisma.printer.findFirst({ where: { shopId: shop.id } }))
  ?? await prisma.printer.create({ data: { shopId: shop.id, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' } });
if (!(await prisma.agent.findFirst({ where: { shopId: shop.id } }))) {
  await prisma.agent.create({ data: { shopId: shop.id, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online', connectedPrinterIds: [printer.id], lastHeartbeatAt: new Date() } });
}
const student = await prisma.student.upsert({ where: { phone: '+919000000001' }, update: {}, create: { phone: '+919000000001', name: `Stu ${LONG}` } });

async function job(status: 'awaiting_arrival' | 'queued' | 'completed', code: string) {
  const file = await prisma.uploadedFile.create({
    data: { studentId: student.id, shopId: shop.id, originalName: `${LONG}.pdf`, originalKey: `k-${randomUUID()}`, mimeType: 'application/pdf', sizeBytes: 1, pages: 3, status: 'ready' },
  });
  return prisma.job.create({
    data: {
      shopId: shop.id, studentId: student.id, fileId: file.id, assignedPrinterId: printer.id,
      specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null },
      pagesPerCopy: 3, priceBreakdown: {}, totalPaise: 600, status,
      paymentProvider: 'pay_at_shop', paymentStatus: status === 'completed' ? 'paid' : 'counter_due',
      releaseCodeDigest: digestReleaseCode(shop.id, code), releaseCodeEncrypted: encryptReleaseCode(shop.id, code),
      releaseCodeGeneratedAt: new Date(), ...(status === 'queued' ? { queuedAt: new Date(), arrivedAt: new Date(), revealedAt: new Date(), revealDeadlineAt: new Date(Date.now() + 600_000) } : {}),
    },
  });
}
await job('awaiting_arrival', '111111');
const queued = await job('queued', '222222');
await job('completed', '333333');
writeFileSync(process.argv[2]!, JSON.stringify({
  student: signStudentToken(student.id), shop: signShopToken(owner.id, shop.id, 'owner'), slug: shop.slug, queuedJobId: queued.id,
}));
await prisma.$disconnect();
console.log('seeded');
