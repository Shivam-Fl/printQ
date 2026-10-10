import { describe, expect, it } from 'vitest';
import { deriveStatementAmounts, hasUnappliedCredit } from './statements.js';
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

describe('weekly statement period', () => {
  it('uses the last complete Monday–Sunday IST window', () => {
    const period = lastCompletedWeeklyPeriodInIndia(new Date('2026-09-21T06:30:00.000Z')); // Monday noon IST
    expect(period.start.toISOString()).toBe('2026-09-13T18:30:00.000Z');
    expect(period.end.toISOString()).toBe('2026-09-20T18:30:00.000Z');
  });
});
