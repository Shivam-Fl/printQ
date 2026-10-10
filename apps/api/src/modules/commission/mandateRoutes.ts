import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/errors.js';
import { requireShopOwner } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { cancelMandate, getMandateView, startMandate } from './mandateService.js';

/**
 * Weekly-commission UPI AutoPay (Razorpay TEST only; the service answers 404
 * unless SHOP_COLLECTION_MODE=test outside production). Mounted at
 * /api/shop/collection-mandate. Owner-only; every query is scoped to the
 * caller's shop; no amount is accepted from the client.
 */
export const mandateRouter = Router();

mandateRouter.get(
  '/',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    res.json(await getMandateView(req.shopUser!.shopId));
  }),
);

const startMandateSchema = z.object({
  acceptTerms: z.literal(true, { message: 'You must accept the AutoPay terms' }),
  contact: z.string().regex(/^\+[1-9]\d{7,14}$/, 'Enter the mobile number in +91XXXXXXXXXX format'),
}).strict();

mandateRouter.post(
  '/',
  requireShopOwner,
  validateBody(startMandateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof startMandateSchema>;
    const checkout = await startMandate({
      shopId: req.shopUser!.shopId,
      ownerId: req.shopUser!.id,
      acceptTerms: body.acceptTerms,
      contactE164: body.contact,
    });
    res.status(201).json({ checkout });
  }),
);

mandateRouter.post(
  '/cancel',
  requireShopOwner,
  asyncHandler(async (req, res) => {
    await cancelMandate(req.shopUser!.shopId);
    res.json({ ok: true });
  }),
);
