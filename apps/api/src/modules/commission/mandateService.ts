import { Prisma, type CollectionMandateStatus } from '@prisma/client';
import { env } from '../../config/env.js';
import { conflict, HttpError, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { encryptToken, readStoredToken } from '../../lib/tokenCrypto.js';
import { RazorpayTestRecurringClient } from '../../providers/payment/recurringTest.js';

/**
 * Shop-owner UPI AutoPay mandate lifecycle (Razorpay TEST only).
 * Docs: https://razorpay.com/docs/payments/recurring-payments/upi/
 *       https://razorpay.com/docs/api/payments/recurring-payments/upi/create-authorization-transaction/
 * A mandate is usable only after the signed `token.confirmed` webhook.
 */
type Client = Pick<RazorpayTestRecurringClient, 'createCustomer' | 'createMandateOrder' | 'cancelToken'>;

/** An abandoned Checkout may be restarted after this long. */
export const PENDING_MANDATE_TTL_MS = 30 * 60 * 1_000;
const MANDATE_VALIDITY_MS = 365 * 24 * 60 * 60 * 1_000;
const OPEN_STATUSES: CollectionMandateStatus[] = ['pending', 'active', 'paused'];

export function collectionEnabled(): boolean {
  return env.SHOP_COLLECTION_MODE === 'test' && env.PRINTQ_ENVIRONMENT !== 'production';
}

function assertEnabled(): void {
  if (!collectionEnabled()) throw notFound();
}

const providerUnavailable = () => new HttpError(502, 'The payment provider could not be reached. Please try again.');

export interface MandateView {
  enabled: boolean;
  pilotCapPaise: number;
  mandate: null | {
    status: CollectionMandateStatus;
    maxAmountPaise: number;
    validUntil: string;
    activatedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };
}

/** Never includes provider ids or tokens. */
export async function getMandateView(shopId: string): Promise<MandateView> {
  const pilotCapPaise = env.SHOP_COLLECTION_PILOT_CAP_PAISE;
  if (!collectionEnabled()) return { enabled: false, pilotCapPaise, mandate: null };
  const row = await prisma.shopCollectionMandate.findFirst({
    where: { shopId, provider: 'razorpay', environment: 'test' },
    orderBy: { createdAt: 'desc' },
  });
  return {
    enabled: true,
    pilotCapPaise,
    mandate: row && {
      status: row.status,
      maxAmountPaise: row.maxAmountPaise,
      validUntil: row.validUntil.toISOString(),
      activatedAt: row.activatedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
  };
}

export interface StartMandateInput {
  shopId: string;
  ownerId: string;
  acceptTerms: boolean;
  contactE164: string;
}

export interface CheckoutParams {
  keyId: string;
  orderId: string;
  customerId: string;
  maxAmountPaise: number;
  expiresAt: string;
}

export async function startMandate(
  input: StartMandateInput,
  client: Client = new RazorpayTestRecurringClient(),
  now = new Date(),
): Promise<CheckoutParams> {
  assertEnabled();
  if (input.acceptTerms !== true) throw new HttpError(400, 'You must accept the AutoPay terms');
  const keyId = env.RAZORPAY_RECURRING_TEST_KEY_ID;
  if (!keyId?.startsWith('rzp_test_')) throw providerUnavailable();

  // Owner is looked up scoped to the caller's shop; mismatch reads as 404.
  const owner = await prisma.shopUser.findFirst({
    where: { id: input.ownerId, shopId: input.shopId, role: 'owner' },
    select: { email: true, name: true },
  });
  if (!owner) throw notFound();

  // Reserve the shop's single open mandate under a shop row lock so two
  // concurrent starts cannot both create one.
  const reserved = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${input.shopId} FOR UPDATE`;
    const open = await tx.shopCollectionMandate.findFirst({
      where: { shopId: input.shopId, provider: 'razorpay', environment: 'test', status: { in: OPEN_STATUSES } },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      if (open.status !== 'pending') throw conflict('AutoPay is already set up for this shop');
      const fresh = now.getTime() - open.createdAt.getTime() < PENDING_MANDATE_TTL_MS;
      if (fresh && open.providerCustomerId && open.providerMandateId) return { resume: open, created: null };
      if (fresh) throw conflict('AutoPay setup is already in progress');
      await tx.shopCollectionMandate.updateMany({
        where: { id: open.id, shopId: input.shopId, status: 'pending' },
        data: { status: 'failed' },
      });
    }
    const created = await tx.shopCollectionMandate.create({
      data: {
        shopId: input.shopId,
        provider: 'razorpay',
        environment: 'test',
        method: 'upi_autopay',
        status: 'pending',
        // Cap and validity are server-decided; nothing amount-like comes from the client.
        maxAmountPaise: env.SHOP_COLLECTION_PILOT_CAP_PAISE,
        frequency: 'weekly',
        validFrom: now,
        validUntil: new Date(now.getTime() + MANDATE_VALIDITY_MS),
        cancellationTermsAcceptedAt: now,
        ownerDebitEmail: owner.email,
        ownerDebitContactE164: input.contactE164,
      },
    });
    return { resume: null, created };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

  if (reserved.resume) {
    const m = reserved.resume;
    return {
      keyId, orderId: m.providerMandateId!, customerId: m.providerCustomerId!,
      maxAmountPaise: m.maxAmountPaise, expiresAt: m.validUntil.toISOString(),
    };
  }
  const mandate = reserved.created!;
  try {
    const customerId = await client.createCustomer({
      name: owner.name, email: owner.email, contact: input.contactE164, shopId: input.shopId,
    });
    const orderId = await client.createMandateOrder({
      receipt: mandate.id,
      customerId,
      maxAmountPaise: mandate.maxAmountPaise,
      expireAt: mandate.validUntil,
      pilotCapPaise: env.SHOP_COLLECTION_PILOT_CAP_PAISE,
    });
    await prisma.shopCollectionMandate.updateMany({
      where: { id: mandate.id, shopId: input.shopId, status: 'pending' },
      data: { providerCustomerId: customerId, providerMandateId: orderId },
    });
    return {
      keyId, orderId, customerId,
      maxAmountPaise: mandate.maxAmountPaise, expiresAt: mandate.validUntil.toISOString(),
    };
  } catch (error) {
    await prisma.shopCollectionMandate.updateMany({
      where: { id: mandate.id, shopId: input.shopId, status: 'pending' },
      data: { status: 'failed' },
    });
    logger.warn({ shopId: input.shopId, mandateId: mandate.id, reason: error instanceof Error ? error.message : 'unknown' }, 'mandate_start_failed');
    throw providerUnavailable();
  }
}

export async function cancelMandate(
  shopId: string,
  client: Client = new RazorpayTestRecurringClient(),
  now = new Date(),
): Promise<void> {
  assertEnabled();
  const mandate = await prisma.shopCollectionMandate.findFirst({
    where: { shopId, provider: 'razorpay', environment: 'test', status: { in: OPEN_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
  if (!mandate) throw notFound();
  if (mandate.providerTokenId && mandate.providerCustomerId) {
    try {
      const tokenId = readStoredToken(mandate.providerTokenId, mandate.id);
      await client.cancelToken(mandate.providerCustomerId, tokenId);
    } catch (error) {
      logger.warn({ shopId, mandateId: mandate.id, reason: error instanceof Error ? error.message : 'unknown' }, 'mandate_cancel_failed');
      throw providerUnavailable();
    }
  }
  const updated = await prisma.shopCollectionMandate.updateMany({
    where: { id: mandate.id, shopId, status: { in: OPEN_STATUSES } },
    data: { status: 'revoked', revokedAt: now },
  });
  if (updated.count !== 1) throw conflict('AutoPay changed while cancelling; refresh and retry');
}

// ---- Signed token webhook -----------------------------------------------------

export type TokenEvent = 'token.confirmed' | 'token.rejected' | 'token.cancelled' | 'token.paused';
const TOKEN_EVENTS: readonly string[] = ['token.confirmed', 'token.rejected', 'token.cancelled', 'token.paused'];

export interface ParsedTokenEvent {
  event: TokenEvent;
  tokenId: string | null;
  customerId: string;
  maxAmountPaise: number | null;
}

/** Extracts only the safe, validated fields from a signed token.* payload. */
export function parseTokenEvent(payload: unknown): ParsedTokenEvent | null {
  const body = payload as { event?: unknown; payload?: { token?: { entity?: Record<string, unknown> } } };
  if (typeof body?.event !== 'string' || !TOKEN_EVENTS.includes(body.event)) return null;
  const entity = body.payload?.token?.entity;
  if (!entity) return null;
  const customerId = entity.customer_id;
  if (typeof customerId !== 'string' || !/^cust?_[A-Za-z0-9]+$/.test(customerId)) return null;
  const id = entity.id;
  return {
    event: body.event as TokenEvent,
    tokenId: typeof id === 'string' && /^token_[A-Za-z0-9]+$/.test(id) ? id : null,
    customerId,
    maxAmountPaise: typeof entity.max_amount === 'number' ? entity.max_amount : null,
  };
}

/**
 * Allowed transitions. Terminal states (revoked, failed, expired) never
 * reopen, which makes replays and out-of-order delivery safe.
 */
const TRANSITIONS: Record<TokenEvent, { from: CollectionMandateStatus[]; to: CollectionMandateStatus }> = {
  'token.confirmed': { from: ['pending', 'paused'], to: 'active' },
  'token.rejected': { from: ['pending'], to: 'failed' },
  'token.cancelled': { from: ['pending', 'active', 'paused'], to: 'revoked' },
  'token.paused': { from: ['active'], to: 'paused' },
};

export type TokenEventOutcome = 'applied' | 'ignored' | 'unknown_token';

export async function applyTokenEvent(
  parsed: ParsedTokenEvent,
  providerEventId: string,
  client: Pick<RazorpayTestRecurringClient, 'cancelToken'> = new RazorpayTestRecurringClient(),
  now = new Date(),
): Promise<TokenEventOutcome> {
  if (!collectionEnabled()) return 'ignored';
  const rows = await prisma.shopCollectionMandate.findMany({
    where: { provider: 'razorpay', environment: 'test', providerCustomerId: parsed.customerId },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  const storedMatch = rows.find((row) => {
    if (!row.providerTokenId || !parsed.tokenId) return false;
    try { return readStoredToken(row.providerTokenId, row.id) === parsed.tokenId; } catch { return false; }
  });
  // A first event for a token carries a token id we have not stored yet, so it
  // belongs to the newest mandate for that customer that has no token.
  const mandate = storedMatch ?? rows.find((row) => !row.providerTokenId);
  if (!mandate) {
    logger.info({ providerEventId, event: parsed.event }, 'mandate_token_event_unknown');
    return 'unknown_token';
  }
  const rule = TRANSITIONS[parsed.event];

  if (parsed.event === 'token.confirmed') {
    if (mandate.status === 'revoked' && parsed.tokenId && mandate.providerCustomerId) {
      // Owner cancelled while Checkout was in flight: do not leave a live token.
      try { await client.cancelToken(mandate.providerCustomerId, parsed.tokenId); } catch {
        logger.warn({ mandateId: mandate.id }, 'mandate_orphan_token_cancel_failed');
      }
      return 'ignored';
    }
    if (!parsed.tokenId) return 'ignored';
    if (parsed.maxAmountPaise !== null && parsed.maxAmountPaise !== mandate.maxAmountPaise) {
      // Never activate a mandate whose ceiling is not exactly what we asked for.
      await prisma.shopCollectionMandate.updateMany({
        where: { id: mandate.id, status: { in: ['pending', 'paused'] } },
        data: { status: 'failed' },
      });
      logger.warn({ mandateId: mandate.id, providerEventId }, 'mandate_token_cap_mismatch');
      return 'applied';
    }
  }

  const data: Prisma.ShopCollectionMandateUpdateManyMutationInput = { status: rule.to };
  if (parsed.event === 'token.confirmed') {
    if (!mandate.providerTokenId) data.providerTokenId = encryptToken(parsed.tokenId!, mandate.id);
    if (!mandate.activatedAt) data.activatedAt = now;
  }
  if (parsed.event === 'token.cancelled') data.revokedAt = now;

  const updated = await prisma.shopCollectionMandate.updateMany({
    where: { id: mandate.id, status: { in: rule.from } },
    data,
  });
  logger.info({
    mandateId: mandate.id, shopId: mandate.shopId, event: parsed.event, providerEventId,
    from: mandate.status, to: rule.to, applied: updated.count === 1,
  }, 'mandate_token_event');
  return updated.count === 1 ? 'applied' : 'ignored';
}
