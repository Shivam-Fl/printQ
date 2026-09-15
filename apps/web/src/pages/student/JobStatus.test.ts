import { describe, expect, it } from 'vitest';
import { paymentSummary } from './JobStatus.js';

describe('payment summary', () => {
  it('shows a paid online order as paid and exposes its receipt', () => {
    expect(paymentSummary('paid', 'razorpay', null)).toMatchObject({
      label: 'Amount paid',
      receiptAvailable: true,
    });
  });

  it.each([
    ['pending', 'Payment pending'],
    ['failed', 'Payment failed'],
    ['refunding', 'Refund processing'],
    ['refunded', 'Refunded'],
    ['cash_due', 'Cash due'],
  ] as const)('does not label %s as paid', (status, label) => {
    const summary = paymentSummary(status, status === 'cash_due' ? 'cash' : 'razorpay', null);
    expect(summary.label).toBe(label);
    expect(summary.label).not.toBe('Amount paid');
    expect(summary.receiptAvailable).toBe(false);
  });

  it('labels a collected cash order accurately', () => {
    expect(paymentSummary('cash_due', 'cash', '2026-09-15T10:00:00.000Z')).toMatchObject({
      label: 'Cash collected',
      receiptAvailable: true,
    });
  });
});
