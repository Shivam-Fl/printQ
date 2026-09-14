import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { preparePrintPdf } from './preparePrintPdf.js';

async function samplePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([100, 100]);
  pdf.addPage([200, 200]);
  pdf.addPage([300, 300]);
  pdf.addPage([400, 400]);
  return Buffer.from(await pdf.save());
}

describe('preparePrintPdf', () => {
  it('returns the source unchanged when all pages are requested', async () => {
    const source = await samplePdf();
    expect(await preparePrintPdf(source, null)).toBe(source);
  });

  it('sends only the selected, de-duplicated pages to the printer', async () => {
    const result = await preparePrintPdf(await samplePdf(), '2-3,3');
    const pdf = await PDFDocument.load(result);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPages().map((page) => page.getWidth())).toEqual([200, 300]);
  });
});
