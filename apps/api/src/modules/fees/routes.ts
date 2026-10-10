import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { asyncHandler, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { requireShopOwner, requireShopUser } from '../../middleware/auth.js';
import { feeActionLimiter } from '../../middleware/rateLimit.js';
import { validateBody } from '../../middleware/validate.js';
import { getFeePaymentProvider } from '../../providers/feePayment/index.js';
import { computeFeeAccount } from './account.js';
import { createFeeOrder, mockPayFeeOrder, verifyFeeCheckout } from './payments.js';

/** Legal name printed on fee receipts. */
export const PRINTQS_LEGAL_NAME = 'Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs';

export const feesRouter = Router();

/**
 * Light status for the global dashboard banner. Staff only learn whether the
 * shop is blocked; the owner also gets the amounts.
 */
feesRouter.get(
  '/status',
  requireShopUser,
  asyncHandler(async (req, res) => {
    const account = await computeFeeAccount(prisma, req.shopUser!.shopId);
    const enabled = getFeePaymentProvider() !== null;
    const base = { enabled, state: account.state, banner: enabled ? account.banner : null };
    if (req.shopUser!.role !== 'owner') {
      res.json({ status: base });
      return;
    }
    res.json({
      status: {
        ...base,
        totalDuePaise: account.totalDuePaise,
        nextDueAt: account.nextDueAt,
        blockedAt: account.blockedAt,
      },
    });
  }),
);

/** Full fee account: amount due, statements, payment history. Owner only. */
feesRouter.get(
  '/',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const shopId = req.shopUser!.shopId;
    const provider = getFeePaymentProvider();
    const [account, payments] = await Promise.all([
      computeFeeAccount(prisma, shopId),
      prisma.shopFeePayment.findMany({
        where: { shopId },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, amountPaise: true, status: true, providerPaymentId: true, paidAt: true, createdAt: true, failureReason: true,
        },
      }),
    ]);
    res.json({
      fees: {
        enabled: provider !== null,
        provider: provider?.name ?? null,
        termsDays: env.FEE_PAYMENT_TERMS_DAYS,
        ...account,
        payments,
      },
    });
  }),
);

// The body is intentionally empty: the amount is always computed server-side.
// `.strict()` makes a client-supplied amount a 400 rather than silently ignored.
feesRouter.post(
  '/order',
  requireShopOwner,
  feeActionLimiter,
  validateBody(z.object({}).strict()),
  asyncHandler(async (req, res) => {
    const result = await createFeeOrder(req.shopUser!.shopId, req.shopUser!.id);
    const shop = await prisma.shop.findUnique({ where: { id: req.shopUser!.shopId }, select: { name: true } });
    res.status(result.reused ? 200 : 201).json({
      payment: result.payment,
      checkout: { ...result.checkout, name: 'PrintQs', description: 'Platform fee', shopName: shop?.name ?? null },
    });
  }),
);

const verifySchema = z.object({
  orderId: z.string().regex(/^order_[A-Za-z0-9]+$/),
  paymentId: z.string().regex(/^pay_[A-Za-z0-9]+$/),
  signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
}).strict();

/** Checkout success callback: signature check, then a server-side status re-check. */
feesRouter.post(
  '/verify',
  requireShopOwner,
  feeActionLimiter,
  validateBody(verifySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof verifySchema>;
    res.json(await verifyFeeCheckout(req.shopUser!.shopId, body));
  }),
);

/** Dev/test only (404 unless FEE_PAYMENT_PROVIDER=mock): instantly settle an open order. */
feesRouter.post(
  '/mock-pay',
  requireShopOwner,
  validateBody(z.object({ paymentId: z.string().uuid() }).strict()),
  asyncHandler(async (req, res) => {
    const outcome = await mockPayFeeOrder(req.shopUser!.shopId, (req.body as { paymentId: string }).paymentId);
    res.json({ outcome });
  }),
);

/** Receipt data for one paid fee payment; contains no student information. */
feesRouter.get(
  '/payments/:id/receipt',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    const payment = await prisma.shopFeePayment.findFirst({
      where: { id: param(req, 'id'), shopId: req.shopUser!.shopId, status: 'paid' },
      include: {
        shop: { select: { name: true } },
        allocations: {
          orderBy: { statement: { periodEnd: 'asc' } },
          select: {
            amountPaise: true,
            statement: { select: { periodStart: true, periodEnd: true } },
          },
        },
      },
    });
    if (!payment) throw notFound();
    res.json({
      receipt: {
        receiptNo: payment.id.slice(0, 8).toUpperCase(),
        issuer: PRINTQS_LEGAL_NAME,
        shopName: payment.shop.name,
        paidAt: payment.paidAt,
        amountPaise: payment.amountPaise,
        currency: payment.currency,
        providerPaymentId: payment.providerPaymentId,
        periods: payment.allocations.map((a) => ({
          periodStart: a.statement.periodStart,
          periodEnd: a.statement.periodEnd,
          amountPaise: a.amountPaise,
        })),
        currentWeekPaise: payment.allocations.length
          ? payment.amountPaise - payment.allocations.reduce((sum, a) => sum + a.amountPaise, 0)
          : payment.amountPaise,
      },
    });
  }),
);

const pushSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(300), auth: z.string().min(1).max(100) }),
}).strict();

/** Owner device registration for fee Web Push. */
feesRouter.post(
  '/push/subscribe',
  requireShopOwner,
  validateBody(pushSchema),
  asyncHandler(async (req, res) => {
    const { endpoint, keys } = req.body as z.infer<typeof pushSchema>;
    await prisma.shopPushSubscription.upsert({
      where: { endpoint },
      create: { shopUserId: req.shopUser!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth },
      update: { shopUserId: req.shopUser!.id, p256dh: keys.p256dh, auth: keys.auth },
    });
    res.json({ ok: true });
  }),
);

feesRouter.post(
  '/push/unsubscribe',
  requireShopOwner,
  validateBody(z.object({ endpoint: z.string().url().max(1000) }).strict()),
  asyncHandler(async (req, res) => {
    const { endpoint } = req.body as { endpoint: string };
    await prisma.shopPushSubscription.deleteMany({ where: { endpoint, shopUserId: req.shopUser!.id } });
    res.json({ ok: true });
  }),
);
