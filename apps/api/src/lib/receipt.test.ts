import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { paymentLine, renderReceipt, type ReceiptData } from './receipt.js';

const base: ReceiptData = {
  jobId: 'abcdef12-0000-0000-0000-000000000000',
  createdAt: new Date('2026-10-10T05:00:00Z'),
  shopName: 'Test Shop',
  shopAddress: 'Lane 1',
  studentLabel: 'Asha',
  fileName: 'doc.pdf',
  specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: '1-3,3,5' },
  breakdown: { pagesTotalPaise: 400, bindingPaise: 0 } as never,
  totalPaise: 500,
  paymentStatus: 'paid',
  showPriceBreakdown: false,
};

async function text(data: ReceiptData): Promise<string> {
  const raw = Buffer.from(await renderReceipt(data)).toString('latin1');
  // page content streams are Flate-compressed: inflate every stream and join the text
  const out: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try {
      out.push(inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1'));
    } catch {
      // fonts etc. - not text content
    }
  }
  // pdf-lib writes shown text as hex strings: <48656C6C6F> Tj
  return out
    .join('\n')
    .replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_m, hex: string) => Buffer.from(hex, 'hex').toString('latin1') + '\n');
}

describe('receipt content', () => {
  it('shows the normalized page range, not the raw one', async () => {
    const out = await text({ ...base, totalPages: 10 });
    expect(out).toContain('Pages: 1-3,5');
    expect(out).not.toContain('1-3,3,5');
  });

  it('shows the completion date (not creation) and the payment method', async () => {
    const out = await text({
      ...base,
      completedAt: new Date('2026-10-11T08:00:00Z'),
      counterPaymentMethod: 'shop_upi',
    });
    expect(out).toContain('Completed: 11/10/2026');
    expect(out).not.toContain('10/10/2026');
    expect(out).toContain('Payment: Paid at shop (UPI)');
  });

  it('falls back to the order date while the job is still in flight, and never prints base/commission', async () => {
    const out = await text(base);
    expect(out).toContain('Ordered: 10/10/2026');
    expect(out.toLowerCase()).not.toContain('commission');
    expect(out.toLowerCase()).not.toContain('shop base');
  });

  it('payment wording', () => {
    expect(paymentLine({ paymentStatus: 'paid', counterPaymentMethod: 'cash' })).toBe('Paid at shop (cash)');
    expect(paymentLine({ paymentStatus: 'paid', counterPaymentMethod: null })).toBe('Paid at shop');
    expect(paymentLine({ paymentStatus: 'refunded', counterPaymentMethod: 'cash' })).toBe('refunded');
  });
});
