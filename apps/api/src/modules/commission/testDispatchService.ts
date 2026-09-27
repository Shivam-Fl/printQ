import { Prisma } from '@prisma/client';
import { env } from '../../config/env.js';
import { conflict } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { RazorpayTestRecurringClient } from '../../providers/payment/recurringTest.js';
import { debitGateReason, UPI_PRE_DEBIT_NOTICE_MS } from './statements.js';

type Attempt = Prisma.ShopCommissionCollectionAttemptGetPayload<{
  include: { statement: { include: { mandate: true } } };
}>;
type TestClient = Pick<RazorpayTestRecurringClient, 'createOrder' | 'charge'>;

function assertDispatchReady(attempt: Attempt, now: Date): asserts attempt is Attempt & {
  statement: Attempt['statement'] & {
    mandate: NonNullable<Attempt['statement']['mandate']> & {
      providerCustomerId: string;
      providerTokenId: string;
      ownerDebitEmail: string;
      ownerDebitContactE164: string;
    };
  };
} {
  const statement = attempt.statement;
  const mandate = statement.mandate;
  if (
    attempt.provider !== 'razorpay_test' || attempt.status !== 'pending'
    || attempt.providerOrderId || attempt.providerCollectionId
    || statement.status !== 'debit_pending'
    || attempt.amountPaise !== statement.amountDuePaise
    || !mandate || mandate.shopId !== statement.shopId
    || mandate.provider !== 'razorpay' || mandate.environment !== 'test'
    || mandate.frequency !== 'weekly' || !mandate.providerMandateId
    || !mandate.providerCustomerId || !mandate.providerTokenId
    || !mandate.ownerDebitEmail || !mandate.ownerDebitContactE164
  ) throw conflict('TEST collection attempt has no complete authorized mandate');

  const reason = debitGateReason({
    // Reservation already advanced the statement to debit_pending. All other
    // gates are re-evaluated immediately before claiming an external debit.
    statementStatus: 'notice_sent',
    amountDuePaise: statement.amountDuePaise,
    noticeSentAt: statement.preDebitNoticeSentAt,
    debitNotBefore: statement.debitNotBefore,
    mandateStatus: mandate.status,
    mandateMaxAmountPaise: mandate.maxAmountPaise,
    mandateValidFrom: mandate.validFrom,
    mandateValidUntil: mandate.validUntil,
    mandateTermsAcceptedAt: mandate.cancellationTermsAcceptedAt,
    pilotCapPaise: env.SHOP_COLLECTION_PILOT_CAP_PAISE,
    now,
  });
  if (reason) throw conflict(reason);
  if (
    mandate.method === 'upi_autopay'
    && (!statement.preDebitNoticeSentAt
      || now.getTime() - statement.preDebitNoticeSentAt.getTime() < UPI_PRE_DEBIT_NOTICE_MS)
  ) throw conflict('UPI AutoPay TEST debit requires a 48-hour pre-debit notice');
}

/**
 * Single-shot TEST dispatch. Persist the provider order before attempting the
 * charge. After an ambiguous result, never send a second debit automatically;
 * reconcile the saved order and signed webhooks with Razorpay first.
 */
export async function dispatchTestCollectionAttempt(
  attemptId: string,
  client: TestClient = new RazorpayTestRecurringClient(),
  now = new Date(),
): Promise<{ orderId: string; paymentId: string }> {
  if (env.SHOP_COLLECTION_MODE !== 'test' || env.PRINTQ_ENVIRONMENT === 'production') {
    throw conflict('Razorpay TEST collection is disabled in this environment');
  }
  const candidate = await prisma.shopCommissionCollectionAttempt.findUnique({
    where: { id: attemptId },
    include: { statement: { include: { mandate: true } } },
  });
  if (!candidate) throw conflict('TEST collection attempt not found');
  assertDispatchReady(candidate, now);

  // Unused orders are harmless; no debit occurs until one contender claims
  // the attempt and submits the separate recurring-payment request.
  const orderId = await client.createOrder(candidate.id, candidate.amountPaise);
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Shop" WHERE "id" = ${candidate.statement.shopId} FOR UPDATE`;
    const fresh = await tx.shopCommissionCollectionAttempt.findUnique({
      where: { id: attemptId },
      include: { statement: { include: { mandate: true } } },
    });
    if (!fresh) return false;
    assertDispatchReady(fresh, new Date(Math.max(now.getTime(), Date.now())));
    const other = await tx.shopCommissionCollectionAttempt.findFirst({
      where: {
        id: { not: attemptId },
        status: 'submitted',
        statement: { shopId: fresh.statement.shopId },
      },
      select: { id: true },
    });
    if (other) throw conflict('Another shop debit awaits provider resolution');
    const updated = await tx.shopCommissionCollectionAttempt.updateMany({
      where: { id: attemptId, status: 'pending', providerOrderId: null },
      data: { status: 'submitted', providerOrderId: orderId, submittedAt: new Date() },
    });
    return updated.count === 1;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (!claimed) throw conflict('TEST collection attempt was already claimed');

  let paymentId: string;
  try {
    paymentId = await client.charge({
      orderId,
      amountPaise: candidate.amountPaise,
      customerId: candidate.statement.mandate.providerCustomerId,
      tokenId: candidate.statement.mandate.providerTokenId,
      email: candidate.statement.mandate.ownerDebitEmail,
      contact: candidate.statement.mandate.ownerDebitContactE164,
    });
  } catch {
    throw conflict('TEST debit outcome unknown; reconcile provider order before retry');
  }

  const recorded = await prisma.shopCommissionCollectionAttempt.updateMany({
    where: { id: attemptId, status: 'submitted', providerOrderId: orderId, providerCollectionId: null },
    data: { providerCollectionId: paymentId },
  });
  if (recorded.count !== 1) {
    // A signed captured webhook may have settled the statement while the API
    // response was in flight. Only the same payment ID is an acceptable race.
    const latest = await prisma.shopCommissionCollectionAttempt.findUnique({ where: { id: attemptId } });
    if (latest?.providerCollectionId !== paymentId || latest.status !== 'settled') {
      throw conflict('TEST debit response conflicts with the saved settlement');
    }
  }
  return { orderId, paymentId };
}
