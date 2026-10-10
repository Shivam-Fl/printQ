import { api } from '../api.js';

export type FeeState = 'paid_up' | 'due' | 'overdue' | 'blocked';
export type FeeBannerLevel = 'due_soon' | 'overdue' | 'blocked' | null;

export interface FeeStatementRow {
  id: string;
  periodStart: string;
  periodEnd: string;
  ordersCount: number;
  amountPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  dueAt: string | null;
  status: 'paid' | 'unpaid' | 'overdue';
}

export interface FeePaymentRow {
  id: string;
  amountPaise: number;
  status: 'created' | 'attempted' | 'failed' | 'paid' | 'expired';
  providerPaymentId: string | null;
  paidAt: string | null;
  createdAt: string;
}

export interface FeeOverview {
  enabled: boolean;
  provider: 'mock' | 'razorpay' | null;
  termsDays: number;
  totalDuePaise: number;
  statementsDuePaise: number;
  accruedPaise: number;
  nextDueAt: string | null;
  state: FeeState;
  banner: FeeBannerLevel;
  statements: FeeStatementRow[];
  payments: FeePaymentRow[];
}

export interface FeeStatus {
  enabled: boolean;
  state: FeeState;
  banner: FeeBannerLevel;
  totalDuePaise?: number;
  nextDueAt?: string | null;
}

const DAY_MS = 86_400_000;

export const formatRupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;

export const formatDay = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/** "Due in 3 days" / "Due today" / "Overdue by 2 days" (whole days, IST-agnostic). */
export function dueCountdown(dueAtIso: string | null, now = Date.now()): string | null {
  if (!dueAtIso) return null;
  const diff = new Date(dueAtIso).getTime() - now;
  if (diff <= 0) {
    const days = Math.floor(-diff / DAY_MS);
    return days === 0 ? 'Overdue since today' : `Overdue by ${days} day${days === 1 ? '' : 's'}`;
  }
  const days = Math.ceil(diff / DAY_MS);
  if (days <= 1) return 'Due within a day';
  return `Due in ${days} days`;
}

export const STATE_CHIP: Record<FeeState, { label: string; tone: 'green' | 'blue' | 'yellow' | 'red' }> = {
  paid_up: { label: 'Paid up', tone: 'green' },
  due: { label: 'Due', tone: 'yellow' },
  overdue: { label: 'Overdue', tone: 'red' },
  blocked: { label: 'Blocked', tone: 'red' },
};

export function bannerCopy(status: Pick<FeeStatus, 'banner' | 'totalDuePaise' | 'nextDueAt'>, isOwner: boolean): { tone: 'warn' | 'danger'; text: string } | null {
  const amount = status.totalDuePaise !== undefined ? formatRupees(status.totalDuePaise) : null;
  if (status.banner === 'blocked') {
    return {
      tone: 'danger',
      text: isOwner
        ? `Your shop is temporarily paused for new orders${amount ? `. Pay ${amount} and it reopens right away` : ''}. Orders already in your queue are unaffected.`
        : 'This shop is temporarily paused for new orders. Please ask the owner to clear the PrintQs fee.',
    };
  }
  if (!isOwner) return null;
  if (status.banner === 'overdue') {
    return { tone: 'danger', text: `Your PrintQs fee${amount ? ` of ${amount}` : ''} is overdue. Pay now to avoid a pause on new orders.` };
  }
  if (status.banner === 'due_soon') {
    return {
      tone: 'warn',
      text: `Your PrintQs fee${amount ? ` of ${amount}` : ''} is due${status.nextDueAt ? ` on ${formatDay(status.nextDueAt)}` : ' soon'}. Pay now to keep taking orders.`,
    };
  }
  return null;
}

interface RazorpayCheckoutOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
}
interface RazorpayInstance {
  open(): void;
  on(event: 'payment.failed', handler: (response: { error?: { description?: string } }) => void): void;
}
declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => RazorpayInstance;
  }
}

let checkoutLoad: Promise<void> | null = null;

/** checkout.js is loaded only when the owner clicks Pay. */
export function loadRazorpayCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  checkoutLoad ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      checkoutLoad = null;
      reject(new Error('Could not load the payment window. Check your connection and try again.'));
    };
    document.head.appendChild(script);
  });
  return checkoutLoad;
}

export type PayOutcome =
  | { kind: 'paid' }
  | { kind: 'pending' }
  | { kind: 'dismissed' }
  | { kind: 'failed'; message: string };

interface OrderResponse {
  payment: { id: string; amountPaise: number };
  checkout: { mode: 'razorpay' | 'mock'; keyId?: string; orderId: string; amountPaise: number; currency: string; name?: string; description?: string };
}

/**
 * The amount is never sent: the server creates the order for exactly what is due.
 * Mock mode (local QA) settles instantly through the dev-only endpoint.
 */
export async function payFees(): Promise<PayOutcome> {
  const order = await api<OrderResponse>('/api/shop/fees/order', { method: 'POST', role: 'shop', body: {} });
  if (order.checkout.mode === 'mock') {
    await api('/api/shop/fees/mock-pay', { method: 'POST', role: 'shop', body: { paymentId: order.payment.id } });
    return { kind: 'paid' };
  }
  await loadRazorpayCheckout();
  const Razorpay = window.Razorpay;
  if (!Razorpay || !order.checkout.keyId) return { kind: 'failed', message: 'The payment window is unavailable. Please try again.' };

  return new Promise<PayOutcome>((resolve) => {
    const checkout = new Razorpay({
      key: order.checkout.keyId!,
      order_id: order.checkout.orderId,
      amount: order.checkout.amountPaise,
      currency: order.checkout.currency,
      name: order.checkout.name ?? 'PrintQs',
      description: order.checkout.description ?? 'Platform fee',
      theme: { color: '#2242C8' },
      modal: { ondismiss: () => resolve({ kind: 'dismissed' }) },
      handler: (response) => {
        // The browser callback is only a hint: the server checks the signature
        // and then asks Razorpay what actually happened.
        api<{ status: 'paid' | 'pending' | 'failed' }>('/api/shop/fees/verify', {
          method: 'POST',
          role: 'shop',
          body: {
            orderId: response.razorpay_order_id,
            paymentId: response.razorpay_payment_id,
            signature: response.razorpay_signature,
          },
        })
          .then((result) => resolve(result.status === 'paid' ? { kind: 'paid' } : { kind: 'pending' }))
          .catch(() => resolve({ kind: 'pending' }));
      },
    });
    checkout.on('payment.failed', (response) => {
      resolve({ kind: 'failed', message: response.error?.description ?? 'The payment did not go through. You have not been charged twice — try again.' });
    });
    checkout.open();
  });
}

export function outcomeMessage(outcome: PayOutcome): { tone: 'ok' | 'info' | 'error'; text: string } | null {
  switch (outcome.kind) {
    case 'paid':
      return { tone: 'ok', text: 'Payment received. Thank you — your receipt is below.' };
    case 'pending':
      return { tone: 'info', text: 'Your payment is being confirmed. This usually takes under a minute; this page updates on its own. Do not pay again.' };
    case 'dismissed':
      return { tone: 'info', text: 'Payment window closed. Nothing was charged. You can pay whenever you are ready.' };
    case 'failed':
      return { tone: 'error', text: outcome.message };
  }
}
