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
