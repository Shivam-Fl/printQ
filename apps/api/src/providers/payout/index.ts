import { env } from '../../config/env.js';

export interface PayoutRequest {
  payoutId: string;
  linkedAccountId: string | null;
  amountPaise: number;
  shopId: string;
}

export interface PayoutResult {
  providerTransferId: string;
  status: 'processing' | 'paid';
}

export class PayoutProviderError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
  }
}

class MockPayoutProvider {
  readonly name = 'mock' as const;

  async send(request: PayoutRequest): Promise<PayoutResult> {
    return { providerTransferId: `mock_${request.payoutId}`, status: 'paid' };
  }
}

class RazorpayRoutePayoutProvider {
  readonly name = 'razorpay_route' as const;

  async send(request: PayoutRequest): Promise<PayoutResult> {
    if (!request.linkedAccountId) {
      throw new PayoutProviderError('Shop does not have an active Razorpay Route linked account', false);
    }
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
    let response: Response;
    try {
      response = await fetch('https://api.razorpay.com/v1/transfers', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          'X-Transfer-Idempotency': request.payoutId,
        },
        body: JSON.stringify({
          account: request.linkedAccountId,
          amount: request.amountPaise,
          currency: 'INR',
          notes: { printqPayoutId: request.payoutId, shopId: request.shopId },
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new PayoutProviderError(error instanceof Error ? error.message : 'Razorpay transfer request failed', true);
    }

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
      throw new PayoutProviderError(`Razorpay Route transfer failed (${response.status}): ${detail}`, retryable);
    }

    const transfer = (await response.json()) as { id: string; status?: string; transfer_status?: string };
    const status = transfer.transfer_status ?? transfer.status;
    return {
      providerTransferId: transfer.id,
      status: status === 'processed' ? 'paid' : 'processing',
    };
  }
}

export const payoutProvider = env.SHOP_PAYOUT_PROVIDER === 'razorpay_route'
  ? new RazorpayRoutePayoutProvider()
  : new MockPayoutProvider();
