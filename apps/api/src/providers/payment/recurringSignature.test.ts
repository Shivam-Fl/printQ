import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyRazorpayRecurringWebhookSignature } from './index.js';

const payload = Buffer.from('{"event":"payment.captured"}');
const recurringSecret = 'recurring-test-webhook-secret';
const legacyStudentSecret = 'retired-student-webhook-secret';

function signature(secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Razorpay shop-recurring webhook signature', () => {
  it('accepts only the dedicated recurring secret, not the retired student secret', () => {
    expect(verifyRazorpayRecurringWebhookSignature(payload, signature(recurringSecret), recurringSecret)).toBe(true);
    expect(verifyRazorpayRecurringWebhookSignature(payload, signature(legacyStudentSecret), recurringSecret)).toBe(false);
  });

  it('fails closed when the dedicated secret is absent or signature is malformed', () => {
    expect(verifyRazorpayRecurringWebhookSignature(payload, signature(''), '')).toBe(false);
    expect(verifyRazorpayRecurringWebhookSignature(payload, 'not-hex', recurringSecret)).toBe(false);
  });
});
