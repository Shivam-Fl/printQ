import { describe, expect, it } from 'vitest';
import { PRE_DEBIT_NOTICE_MS, debitGateReason, deriveStatementAmounts, hasUnappliedCredit } from './statements.js';
import { lastCompletedWeeklyPeriodInIndia } from './statementService.js';

describe('weekly commission statement arithmetic', () => {
  it('keeps every paise explained by commission or credit', () => {
    expect(deriveStatementAmounts([
      { id: 'a', amountPaise: 125 },
      { id: 'b', amountPaise: 75 },
      { id: 'credit', amountPaise: -40 },
    ])).toEqual({ grossCommissionPaise: 200, creditPaise: 40, amountDuePaise: 160 });
  });

  it('does not create a negative debit when credit exceeds commission', () => {
    const amounts = deriveStatementAmounts([{ id: 'credit', amountPaise: -500 }]);
    expect(amounts).toEqual({
      grossCommissionPaise: 0,
      creditPaise: 500,
      amountDuePaise: 0,
    });
    expect(hasUnappliedCredit(amounts)).toBe(true);
    expect(hasUnappliedCredit(deriveStatementAmounts([
      { id: 'credit', amountPaise: -500 },
      { id: 'later-commission', amountPaise: 800 },
    ]))).toBe(false);
  });
});

describe('variable recurring-debit gate', () => {
  const now = new Date('2026-09-21T12:00:00.000Z');
  const valid = {
    statementStatus: 'notice_sent' as const,
    amountDuePaise: 15_000,
    noticeSentAt: new Date(now.getTime() - PRE_DEBIT_NOTICE_MS),
    debitNotBefore: now,
    mandateStatus: 'active' as const,
    mandateMaxAmountPaise: 20_000,
    mandateValidFrom: new Date('2026-09-01T00:00:00.000Z'),
    mandateValidUntil: new Date('2026-10-01T00:00:00.000Z'),
    mandateTermsAcceptedAt: new Date('2026-08-31T00:00:00.000Z'),
    pilotCapPaise: 1_500_000,
    now,
  };

  it('allows an exact test debit only after the 24-hour notice window', () => {
    expect(debitGateReason(valid)).toBeNull();
  });

  it('blocks early, oversized and inactive-mandate attempts', () => {
    expect(debitGateReason({ ...valid, debitNotBefore: new Date(now.getTime() + 1) })).toMatch(/still open/);
    expect(debitGateReason({ ...valid, amountDuePaise: 1_500_001 })).toMatch(/pilot debit cap/);
    expect(debitGateReason({ ...valid, mandateStatus: 'revoked' })).toMatch(/not active/);
    expect(debitGateReason({ ...valid, mandateValidUntil: now })).toMatch(/validity period/);
    expect(debitGateReason({ ...valid, mandateTermsAcceptedAt: null })).toMatch(/terms/);
  });
});

describe('weekly statement period', () => {
  it('uses the last complete Monday–Sunday IST window', () => {
    const period = lastCompletedWeeklyPeriodInIndia(new Date('2026-09-21T06:30:00.000Z')); // Monday noon IST
    expect(period.start.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(period.end.toISOString()).toBe('2026-09-20T18:30:00.000Z');
  });
});
