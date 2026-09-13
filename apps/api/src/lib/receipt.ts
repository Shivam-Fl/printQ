import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { JobSpecs, PriceBreakdown } from '@printq/shared';

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
  /** Student receipts show a single final charge; owner copies may be itemized. */
  showPriceBreakdown?: boolean;
}

const rupees = (paise: number) => `Rs ${(paise / 100).toFixed(2)}`;

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
  draw(`Date: ${data.createdAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
  draw(`Student: ${data.studentLabel}`);
  draw(`File: ${data.fileName}`);
  y -= 4;
  rule();

  draw(`Copies: ${data.specs.copies}`);
  draw(`Paper: ${data.specs.paperSize}${data.specs.color ? ' (colour)' : ' (B/W)'}`);
  draw(`Sides: ${data.specs.duplex ? 'Both' : 'One'}`);
  draw(`Binding: ${data.specs.binding ?? 'None'}`);
  draw(`Pages: ${data.specs.pageRange ?? 'All'}`);
  y -= 4;
  rule();

  if (data.showPriceBreakdown !== false) {
    draw(`Pages x copies: ${rupees(data.breakdown.pagesTotalPaise)}`);
    if (data.breakdown.bindingPaise > 0) draw(`Binding: ${rupees(data.breakdown.bindingPaise)}`);
  }
  draw(`Total: ${rupees(data.totalPaise)}`, { size: 12, f: bold, gap: 20 });
  draw(`Payment: ${data.paymentStatus}`, { size: 9 });

  y -= 10;
  draw('Thank you for using PrintQ.', { size: 8, gap: 12 });

  return doc.save();
}
