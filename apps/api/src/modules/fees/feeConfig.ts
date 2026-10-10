import type { CommissionStatementStatus } from '@prisma/client';
import { env } from '../../config/env.js';

export const DAY_MS = 86_400_000;
/** A Checkout order is reused only while it is this young. */
export const FEE_ORDER_TTL_MS = 60 * 60_000;
/** Orders still open after this long are checked against the provider (missed webhook). */
export const FEE_RECONCILE_AFTER_MS = 15 * 60_000;
/** Reconciliation stops looking at an order after this age. */
export const FEE_RECONCILE_MAX_AGE_MS = 48 * 60 * 60_000;
/** The banner turns to "due soon" this long before the due date. */
export const FEE_DUE_SOON_MS = 2 * DAY_MS;

/** Statement states that still owe money (the pre-existing AutoPay states are dormant). */
export const UNPAID_STATEMENT_STATUSES: CommissionStatementStatus[] = [
  'frozen', 'notice_sent', 'debit_pending', 'failed', 'paused',
];

/** Fee collection (and therefore enforcement) is live only with a payment provider. */
export const feePaymentsEnabled = (): boolean => env.FEE_PAYMENT_PROVIDER !== 'disabled';

export const dueAtFor = (frozenAt: Date): Date =>
  new Date(frozenAt.getTime() + env.FEE_PAYMENT_TERMS_DAYS * DAY_MS);

/** The instant an unpaid statement blocks new orders (default: its due date). */
export const blockAtFor = (dueAt: Date): Date =>
  new Date(dueAt.getTime() + env.FEE_OVERDUE_BLOCK_AFTER_DAYS * DAY_MS);

/** "Day 3" of 7: dueAt - ceil(terms * 4 / 7) days. */
export const reminderAtFor = (dueAt: Date): Date =>
  new Date(dueAt.getTime() - Math.ceil((env.FEE_PAYMENT_TERMS_DAYS * 4) / 7) * DAY_MS);

/** "Day 6" of 7: one day before the due date. */
export const finalWarningAtFor = (dueAt: Date): Date => new Date(dueAt.getTime() - DAY_MS);

/** First notice, sent as soon as the statement is billable. */
export const statementReadyAtFor = (dueAt: Date): Date =>
  new Date(dueAt.getTime() - env.FEE_PAYMENT_TERMS_DAYS * DAY_MS);
