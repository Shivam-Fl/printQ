import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { normalizePageRange, type JobSpecs, type PriceBreakdown } from '@printq/shared';
import { prisma } from './prisma.js';

/** Hand-over time from the audit trail (updatedAt also moves when a rating is saved). */
export async function loadCompletedAt(jobId: string, status: string): Promise<Date | null> {
  if (status !== 'completed') return null;
  const event = await prisma.jobEvent.findFirst({
    where: { jobId, toStatus: 'completed' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return event?.createdAt ?? null;
}

export interface ReceiptData {
  jobId: string;
  createdAt: Date;
  shopName: string;
  shopAddress: string;
  studentLabel: string;
  fileName: string;
  specs: JobSpecs;
  breakdown: PriceBreakdown;
  totalPaise: number;
  paymentStatus: string;
  /** When the order was handed over (completed). Falls back to creation for orders still in flight. */
  completedAt?: Date | null;
  /** How the shop collected payment at the counter. */
  counterPaymentMethod?: 'cash' | 'shop_upi' | null;
  /** Document page count, used to show the page range in its normalized form. */
  totalPages?: number | null;
  /** Student receipts show a single final charge; owner copies may be itemized. */
  showPriceBreakdown?: boolean;
}

const rupees = (paise: number) => `Rs ${(paise / 100).toFixed(2)}`;

/** Payment method wording; never any shop base price or platform commission. */
export function paymentLine(data: Pick<ReceiptData, 'paymentStatus' | 'counterPaymentMethod'>): string {
  if (data.paymentStatus !== 'paid') return data.paymentStatus;
  if (data.counterPaymentMethod === 'cash') return 'Paid at shop (cash)';
  if (data.counterPaymentMethod === 'shop_upi') return 'Paid at shop (UPI)';
  return 'Paid at shop';
}

/** A simple one-page receipt PDF — no external template dependency. */
export async function renderReceipt(data: ReceiptData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 480]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 440;
  const draw = (text: string, opts: { size?: number; f?: typeof font; gap?: number } = {}) => {
    page.drawText(text, { x: 24, y, size: opts.size ?? 10, font: opts.f ?? font, color: rgb(0.1, 0.1, 0.1) });
    y -= opts.gap ?? (opts.size ?? 10) + 6;
  };
  const rule = () => {
    page.drawLine({ start: { x: 24, y }, end: { x: 276, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
    y -= 10;
  };

  draw('PrintQ', { size: 16, f: bold, gap: 22 });
  draw(data.shopName, { size: 12, f: bold });
  draw(data.shopAddress, { size: 9 });
  y -= 4;
  rule();

  draw(`Job: ${data.jobId.slice(0, 8)}`);
  draw(
    data.completedAt
      ? `Completed: ${data.completedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
      : `Ordered: ${data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
  );
  draw(`Student: ${data.studentLabel}`);
  draw(`File: ${data.fileName}`);
  y -= 4;
  rule();

  draw(`Copies: ${data.specs.copies}`);
  draw(`Paper: ${data.specs.paperSize}${data.specs.color ? ' (colour)' : ' (B/W)'}`);
  draw(`Sides: ${data.specs.duplex ? 'Both' : 'One'}`);
  draw(`Binding: ${data.specs.binding ?? 'None'}`);
  draw(`Pages: ${normalizePageRange(data.specs.pageRange, data.totalPages ?? null) ?? 'All'}`);
  y -= 4;
  rule();

  if (data.showPriceBreakdown !== false) {
    draw(`Pages x copies: ${rupees(data.breakdown.pagesTotalPaise)}`);
    if (data.breakdown.bindingPaise > 0) draw(`Binding: ${rupees(data.breakdown.bindingPaise)}`);
  }
  draw(`Total: ${rupees(data.totalPaise)}`, { size: 12, f: bold, gap: 20 });
  draw(`Payment: ${paymentLine(data)}`, { size: 9 });

  y -= 10;
  draw('Thank you for using PrintQ.', { size: 8, gap: 12 });

  return doc.save();
}
