import { describe, expect, it } from 'vitest';
import { jobActions, type ActionJob } from './queueActions.js';

const base: ActionJob = {
  status: 'otp_verified',
  printError: 'The printer reported a problem.',
  paymentProvider: 'pay_at_shop',
  counterPaymentConfirmedAt: '2026-10-10T10:00:00Z',
};

describe('counter dashboard recovery actions', () => {
  it('shows Payment returned for a failed counter-paid print (needs the queue payload field)', () => {
    expect(jobActions(base)).toMatchObject({ retry: true, paymentReturned: true, needsAttention: true });
  });
  it('hides Payment returned when payment was not confirmed at the counter or was online', () => {
    expect(jobActions({ ...base, counterPaymentConfirmedAt: null }).paymentReturned).toBe(false);
    expect(jobActions({ ...base, paymentProvider: 'razorpay' }).paymentReturned).toBe(false);
  });
  it('hides recovery for a healthy job', () => {
    expect(jobActions({ ...base, printError: null })).toMatchObject({ retry: false, paymentReturned: false, needsAttention: false });
  });
  it('printing with a live computer only offers confirm; with an offline computer also retry + return', () => {
    expect(jobActions({ ...base, status: 'printing', printError: null })).toMatchObject({ confirmPrinted: true, retry: false, paymentReturned: false });
    expect(jobActions({ ...base, status: 'printing', printError: null, printAgentOffline: true })).toMatchObject({
      confirmPrinted: true, retry: true, paymentReturned: true, needsAttention: true,
    });
  });
});
