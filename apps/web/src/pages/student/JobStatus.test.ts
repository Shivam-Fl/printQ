import { describe, expect, it } from 'vitest';
import { applyCheckInResult, counterUpiIntentUri, paymentSummary, type JobDetail } from './JobStatus.js';

describe('optimistic check-in', () => {
  it('shows the position and band from the check-in response immediately', () => {
    const before = {
      status: 'awaiting_arrival', position: null, etaMinutes: null, band: null, revealDeadlineAt: null,
      absent: true, canCheckIn: true, arrivedAt: null, checkInCount: 1,
    } as unknown as JobDetail;
    const after = applyCheckInResult(before, {
      id: 'j', status: 'queued', position: 3, etaMinutes: 4, band: 'arriving', revealDeadlineAt: null,
    });
    expect(after).toMatchObject({
      status: 'queued', position: 3, etaMinutes: 4, band: 'arriving', absent: false, canCheckIn: false, checkInCount: 2,
    });
    expect(after.arrivedAt).not.toBeNull();
  });
});

describe('payment summary', () => {
  it('shows a staff-confirmed pay-at-shop order as paid and exposes its receipt', () => {
    expect(paymentSummary('paid')).toMatchObject({
      label: 'Paid at shop',
      receiptAvailable: true,
    });
  });

  it.each([
    ['pending', 'Order preparing'],
    ['failed', 'Payment failed'],
    ['refunding', 'Refund processing'],
    ['refunded', 'Refunded'],
    ['cash_due', 'Pay at shop'],
    ['counter_due', 'Pay at shop'],
  ] as const)('does not label %s as paid', (status, label) => {
    const summary = paymentSummary(status);
    expect(summary.label).toBe(label);
    expect(summary.label).not.toBe('Amount paid');
    expect(summary.receiptAvailable).toBe(false);
  });

});

describe('counter UPI intent', () => {
  it('encodes the verified shop payee and exact final amount', () => {
    const uri = counterUpiIntentUri('shop@bank', 'Print Shop', 10_125, '12345678-1234-1234-1234-123456789012');
    const params = new URL(uri.replace('upi://', 'https://upi/')).searchParams;
    expect(params.get('pa')).toBe('shop@bank');
    expect(params.get('pn')).toBe('Print Shop');
    expect(params.get('am')).toBe('101.25');
    expect(params.get('cu')).toBe('INR');
  });

  it('rejects an invalid amount before generating a payment intent', () => {
    expect(() => counterUpiIntentUri('shop@bank', 'Print Shop', 0, '12345678')).toThrow(RangeError);
  });
});
