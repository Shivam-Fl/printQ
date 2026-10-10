/**
 * Razorpay Checkout for UPI AutoPay mandate registration (TEST).
 * https://razorpay.com/docs/api/payments/recurring-payments/upi/create-authorization-transaction/
 * checkout.js is injected only when the owner presses "Set up AutoPay", never
 * on page load. The mandate is NOT usable when Checkout closes successfully:
 * the server waits for the signed `token.confirmed` webhook.
 */
const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

interface RazorpayInstance { open(): void; on(event: string, cb: (response: unknown) => void): void }
type RazorpayCtor = new (options: Record<string, unknown>) => RazorpayInstance;

let loading: Promise<RazorpayCtor> | null = null;

export function loadCheckoutScript(): Promise<RazorpayCtor> {
  const existing = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<RazorpayCtor>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SRC;
    script.async = true;
    script.onload = () => {
      const ctor = (window as unknown as { Razorpay?: RazorpayCtor }).Razorpay;
      if (ctor) resolve(ctor);
      else { loading = null; reject(new Error('Checkout did not load')); }
    };
    script.onerror = () => { loading = null; script.remove(); reject(new Error('Checkout could not be loaded')); };
    document.head.appendChild(script);
  });
  return loading;
}

export interface MandateCheckout {
  keyId: string;
  orderId: string;
  customerId: string;
}

/** Resolves 'submitted' once the owner completed Checkout, 'dismissed' if closed. */
export async function openMandateCheckout(checkout: MandateCheckout): Promise<'submitted' | 'dismissed' | 'failed'> {
  const Razorpay = await loadCheckoutScript();
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: 'submitted' | 'dismissed' | 'failed') => {
      if (!settled) { settled = true; resolve(result); }
    };
    const instance = new Razorpay({
      key: checkout.keyId,
      order_id: checkout.orderId,
      customer_id: checkout.customerId,
      recurring: '1',
      name: 'PrintQs',
      description: 'Weekly commission AutoPay (test mode)',
      handler: () => done('submitted'),
      modal: { ondismiss: () => done('dismissed') },
      theme: { color: '#1f3a8a' },
    });
    instance.on('payment.failed', () => done('failed'));
    instance.open();
  });
}
