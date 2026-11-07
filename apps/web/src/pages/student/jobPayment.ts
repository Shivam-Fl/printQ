/** What a student's order says about money. Pure helpers, shared by the job page, My jobs and Home. */

export type PaymentStatus = 'pending' | 'counter_due' | 'cash_due' | 'paid' | 'refunding' | 'refunded' | 'failed';

export interface PaymentSummary {
  label: string;
  receiptAvailable: boolean;
  receiptMessage: string;
  /** The order ended before any money changed hands: show the total struck through. */
  nothingCharged: boolean;
}

/** Statuses where the student never paid anything (pay-at-shop money is only taken at the counter). */
const UNPAID: readonly string[] = ['pending', 'counter_due', 'cash_due', 'failed'];

/**
 * A cancelled or expired order that was never paid. The API marks a cancelled pay-at-shop
 * order's payment 'failed', but the student never tried to pay, so "Payment failed" is wrong.
 * Unknown payment status (older API) gives false, so a refunded order is never called "not charged".
 */
export function nothingCharged(jobStatus: string, paymentStatus: string | undefined): boolean {
  return (jobStatus === 'cancelled' || jobStatus === 'expired') && paymentStatus !== undefined && UNPAID.includes(paymentStatus);
}

/** Keep the order total truthful: an order is not a paid order until the API says so. */
export function paymentSummary(paymentStatus: PaymentStatus, jobStatus?: string): PaymentSummary {
  if (jobStatus && nothingCharged(jobStatus, paymentStatus)) {
    return {
      label: `${jobStatus === 'expired' ? 'Expired' : 'Cancelled'} — nothing was charged`,
      receiptAvailable: false,
      receiptMessage: 'You did not pay anything for this order, so there is no receipt.',
      nothingCharged: true,
    };
  }

  const summary = (label: string, receiptMessage: string, receiptAvailable = false): PaymentSummary =>
    ({ label, receiptAvailable, receiptMessage, nothingCharged: false });

  switch (paymentStatus) {
    case 'paid':
      return summary('Paid at shop', '', true);
    case 'cash_due':
    case 'counter_due':
      return summary('Pay at shop', 'Receipt will be available after staff verifies payment at the counter.');
    case 'refunding':
      return summary('Refund processing', 'The payment is being refunded. The receipt will be available once processing is complete.');
    case 'refunded':
      return summary('Refunded', 'This payment was refunded, so there is no active payment receipt.');
    case 'failed':
      return summary('Payment failed', 'No receipt is available because the payment was not completed.');
    case 'pending':
    default:
      return summary('Order preparing', 'Receipt will be available after staff verifies payment at the counter.');
  }
}
