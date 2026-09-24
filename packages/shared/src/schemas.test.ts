import { describe, expect, it } from 'vitest';
import { createJobSchema, releaseOtpSchema } from './schemas.js';

describe('pay-at-shop request contracts', () => {
  const baseJob = {
    fileId: 'e8b64a1c-1a39-43fb-9b97-5f8930fa5841',
    specs: {
      copies: 1,
      paperSize: 'A4',
      color: false,
      duplex: false,
      binding: null,
      pageRange: null,
    },
  };

  it('does not let a student select an online payment rail', () => {
    expect(createJobSchema.safeParse({ ...baseJob, paymentMethod: 'online' }).success).toBe(false);
    expect(createJobSchema.safeParse({ ...baseJob, paymentMethod: 'cash' }).success).toBe(false);
    expect(createJobSchema.safeParse(baseJob).success).toBe(true);
  });

  it('accepts only an explicit counter cash or merchant-UPI confirmation', () => {
    expect(releaseOtpSchema.safeParse({ otp: '123456' }).success).toBe(true);
    expect(releaseOtpSchema.safeParse({
      otp: '123456',
      paymentConfirmation: { method: 'cash' },
    }).success).toBe(true);
    expect(releaseOtpSchema.safeParse({
      otp: '123456',
      paymentConfirmation: { method: 'shop_upi', reference: 'upi-ref-1' },
    }).success).toBe(true);
    expect(releaseOtpSchema.safeParse({
      otp: '123456',
      paymentConfirmation: { method: 'online' },
    }).success).toBe(false);
  });
});
