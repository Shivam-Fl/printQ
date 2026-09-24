/** Minimum required notice before a variable recurring debit. */
export const PRE_DEBIT_NOTICE_MS = 24 * 60 * 60 * 1_000;

export interface CommissionEntryForStatement {
  id: string;
  amountPaise: number;
}

export interface StatementAmounts {
  grossCommissionPaise: number;
  creditPaise: number;
  amountDuePaise: number;
}

/**
 * Computes an exact-paise weekly statement from immutable entry values. A
 * credit cannot make a debit negative; surplus credit remains for the next
 * statement and is visible in the ledger.
 */
export function deriveStatementAmounts(entries: readonly CommissionEntryForStatement[]): StatementAmounts {
  let grossCommissionPaise = 0;
  let creditPaise = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.amountPaise)) throw new RangeError('Statement entries must use integer paise');
    if (entry.amountPaise >= 0) grossCommissionPaise += entry.amountPaise;
    else creditPaise += -entry.amountPaise;
    if (!Number.isSafeInteger(grossCommissionPaise) || !Number.isSafeInteger(creditPaise)) {
      throw new RangeError('Statement total exceeds safe integer paise');
    }
  }
  return {
    grossCommissionPaise,
    creditPaise,
    amountDuePaise: Math.max(0, grossCommissionPaise - creditPaise),
  };
}

/** Surplus credits remain unstatemented until there is enough commission to absorb them. */
export function hasUnappliedCredit(amounts: StatementAmounts): boolean {
  return amounts.creditPaise > amounts.grossCommissionPaise;
}

export interface DebitGateInput {
  statementStatus: 'notice_sent' | 'debit_pending' | 'frozen' | 'settled' | 'failed' | 'paused' | 'draft';
  amountDuePaise: number;
  noticeSentAt: Date | null;
  debitNotBefore: Date | null;
  mandateStatus: 'active' | 'pending' | 'revoked' | 'expired' | 'failed' | null;
  mandateMaxAmountPaise: number | null;
  mandateValidFrom?: Date | null;
  mandateValidUntil?: Date | null;
  mandateTermsAcceptedAt?: Date | null;
  pilotCapPaise: number;
  now: Date;
}

/** Returns the reason a debit must not be sent; null means the gate is open. */
export function debitGateReason(input: DebitGateInput): string | null {
  if (input.statementStatus !== 'notice_sent') return 'Statement is not awaiting debit';
  if (input.amountDuePaise <= 0) return 'Statement has no amount due';
  if (input.mandateStatus !== 'active') return 'Mandate is not active';
  if (!input.mandateTermsAcceptedAt) return 'Mandate terms were not accepted';
  if (!input.mandateValidFrom || !input.mandateValidUntil
    || input.now < input.mandateValidFrom || input.now >= input.mandateValidUntil) {
    return 'Mandate is outside its validity period';
  }
  if (!Number.isInteger(input.amountDuePaise) || !Number.isInteger(input.pilotCapPaise) || input.pilotCapPaise <= 0) {
    return 'Debit amounts must be integer paise';
  }
  if (input.amountDuePaise > input.pilotCapPaise) return 'Statement exceeds the pilot debit cap';
  if (input.mandateMaxAmountPaise == null || input.amountDuePaise > input.mandateMaxAmountPaise) {
    return 'Statement exceeds the mandate maximum';
  }
  if (!input.noticeSentAt || !input.debitNotBefore) return 'Pre-debit notice is missing';
  if (input.debitNotBefore.getTime() < input.noticeSentAt.getTime() + PRE_DEBIT_NOTICE_MS) {
    return 'Pre-debit notice window is too short';
  }
  if (input.now < input.debitNotBefore) return 'Pre-debit notice window is still open';
  return null;
}
