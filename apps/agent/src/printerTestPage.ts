import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export interface PrinterTestPageOptions {
  printerLabel: string;
  paperSize: string;
  color: boolean;
  duplex: boolean;
  bin: string | null;
}

/** A locally generated setup page; no order, student, or uploaded-file data is ever used. */
export async function createPrinterTestPage(options: PrinterTestPageOptions): Promise<Buffer> {
  const document = await PDFDocument.create();
  const page = document.addPage([595.28, 841.89]);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.09, 0.13, 0.24);
  const blue = rgb(0.13, 0.26, 0.78);

  page.drawRectangle({ x: 48, y: 705, width: 499, height: 82, color: blue });
  page.drawText('PrintQs', { x: 72, y: 750, size: 27, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Printer setup test page', { x: 72, y: 726, size: 14, font: regular, color: rgb(1, 1, 1) });
  page.drawText('Check paper size, tray, colour, duplex setting, and print quality.', {
    x: 48, y: 660, size: 15, font: bold, color: navy,
  });

  const rows: Array<[string, string]> = [
    ['Printer profile', options.printerLabel],
    ['Paper / tray', `${options.paperSize}${options.bin ? ` / ${options.bin}` : ''}`],
    ['Print mode', `${options.color ? 'Colour' : 'Black & white'} · ${options.duplex ? 'Duplex' : 'Single-sided'}`],
    ['Result', 'If this page is correct, return to PrintQs and mark the printer ready.'],
  ];
  rows.forEach(([label, value], index) => {
    const y = 595 - index * 72;
    page.drawLine({ start: { x: 48, y: y - 18 }, end: { x: 547, y: y - 18 }, thickness: 1, color: rgb(0.85, 0.88, 0.93) });
    page.drawText(label, { x: 48, y, size: 11, font: bold, color: navy });
    page.drawText(value, { x: 210, y, size: 11, font: regular, color: navy, maxWidth: 330 });
  });
  page.drawText('Generated locally by the PrintQs Shop app — no customer document was printed.', {
    x: 48, y: 116, size: 9, font: regular, color: rgb(0.35, 0.4, 0.5), maxWidth: 480,
  });
  return Buffer.from(await document.save());
}
