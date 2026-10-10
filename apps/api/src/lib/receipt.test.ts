import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { paymentLine, receiptLines, receiptRuns, renderReceipt, type ReceiptData } from './receipt.js';

const base: ReceiptData = {
  jobId: 'abcdef12-0000-0000-0000-000000000000',
  createdAt: new Date('2026-10-10T05:00:00Z'),
  shopName: 'Test Shop',
  shopAddress: 'Lane 1',
  studentLabel: 'Asha',
  specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: '1-3,3,5' },
  breakdown: { pagesTotalPaise: 400, bindingPaise: 0 } as never,
  totalPaise: 500,
  paymentStatus: 'paid',
  showPriceBreakdown: false,
};

const text = async (data: ReceiptData) => (await receiptLines(data)).join('\n');

async function validPdf(data: ReceiptData): Promise<PDFDocument> {
  const bytes = await renderReceipt(data);
  expect(Buffer.from(bytes).subarray(0, 5).toString()).toBe('%PDF-');
  const doc = await PDFDocument.load(bytes);
  expect(doc.getPageCount()).toBe(1);
  return doc;
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

  it('never prints the document file name; shows the page count instead', async () => {
    const withName = { ...base, totalPages: 7, fileName: 'आधार_कार्ड_final.pdf' } as ReceiptData;
    const out = await text(withName);
    expect(out).not.toContain('आधार');
    expect(out).not.toContain('.pdf');
    expect(out).toContain('Document (7 pages)');
    expect(await text({ ...base, totalPages: 1 })).toContain('Document (1 page)');
    expect(await text({ ...base, totalPages: null })).toContain('Document');
  });

  it('payment wording', () => {
    expect(paymentLine({ paymentStatus: 'paid', counterPaymentMethod: 'cash' })).toBe('Paid at shop (cash)');
    expect(paymentLine({ paymentStatus: 'paid', counterPaymentMethod: null })).toBe('Paid at shop');
    expect(paymentLine({ paymentStatus: 'refunded', counterPaymentMethod: 'cash' })).toBe('refunded');
  });
});

describe('receipt is Unicode-safe and never throws', () => {
  it('renders Devanagari shop, address and student names (the old 500)', async () => {
    const data = {
      ...base,
      shopName: 'श्री गणेश प्रिंटिंग एवं ज़ेरॉक्स',
      shopAddress: 'दुकान नं. 4, भिवंडी, महाराष्ट्र 421302',
      studentLabel: 'आशा शर्मा',
      totalPages: 12,
    };
    await validPdf(data);
    const runs = await receiptRuns(data.shopName);
    expect(runs.some((r) => r.script === 'deva')).toBe(true);
    expect(runs.map((r) => r.text).join('')).not.toContain('?');
    expect(await text(data)).toContain('श्री गणेश');
  });

  it('mixes Latin, Devanagari and digits in one line using per-glyph font fallback', async () => {
    const runs = await receiptRuns('Shop भिवंडी No. 42 ज़ेरॉक्स');
    expect(runs.some((r) => r.script === 'latin')).toBe(true);
    expect(runs.some((r) => r.script === 'deva')).toBe(true);
    await validPdf({ ...base, shopName: 'Shop भिवंडी No. 42 ज़ेरॉक्स' });
  });

  it('substitutes ? for characters no bundled font covers (emoji, RTL, CJK) without throwing', async () => {
    const runs = await receiptRuns('Print 🖨️ مطبعة שלום 印刷');
    const joined = runs.map((r) => r.text).join('');
    expect(joined).toContain('Print');
    expect(joined).toContain('?');
    expect(joined).not.toMatch(/[\u{1F5A8}مש印]/u);
    await validPdf({
      ...base,
      shopName: 'Print 🖨️ مطبعة',
      shopAddress: 'שלום עולם 印刷店 👩‍👩‍👧‍👦',
      studentLabel: '‮evil‬ name\u0000\n\r\t🙂',
    });
  });

  it('wraps and truncates very long strings instead of overflowing or throwing', async () => {
    const longWord = 'W'.repeat(5000);
    const longDeva = 'प्रिंटिंग '.repeat(500);
    const data = { ...base, shopName: longWord, shopAddress: longDeva, studentLabel: 'ए'.repeat(10_000) };
    const doc = await validPdf(data);
    const lines = await receiptLines(data);
    expect(lines.length).toBeLessThan(40);
    expect(lines.some((l) => l.endsWith('...'))).toBe(true);
    expect(doc.getPage(0).getHeight()).toBeLessThan(900);
  });

  it('handles empty, whitespace-only and non-string values', async () => {
    await validPdf({ ...base, shopName: '', shopAddress: '   ', studentLabel: undefined as never });
  });

  it('falls back to a minimal ASCII receipt if the Unicode path fails (never a 500)', async () => {
    // corrupt job data (no specs) makes the full layout throw; the download must still be a valid PDF
    const broken = { ...base, specs: null as never, shopName: 'दुकान ✓' };
    await validPdf(broken);
    await validPdf({ ...broken, createdAt: new Date('nope'), totalPages: Number.NaN });
  });
});
