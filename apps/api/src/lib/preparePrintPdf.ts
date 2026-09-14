import { parsePageRange } from '@printq/shared';
import { PDFDocument } from 'pdf-lib';

/**
 * Produce the exact PDF bytes handed to the shop computer. Page-range
 * selection happens server-side, so every printer receives only the pages the
 * student paid for regardless of driver support.
 */
export async function preparePrintPdf(source: Buffer, pageRange: string | null): Promise<Buffer> {
  if (!pageRange) return source;

  const input = await PDFDocument.load(source, { ignoreEncryption: false });
  const selected = parsePageRange(pageRange, input.getPageCount());
  const output = await PDFDocument.create();
  const copied = await output.copyPages(input, selected.map((page) => page - 1));
  for (const page of copied) output.addPage(page);
  return Buffer.from(await output.save());
}
