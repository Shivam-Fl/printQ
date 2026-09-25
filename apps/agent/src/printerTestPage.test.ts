import { describe, expect, it } from 'vitest';
import { createPrinterTestPage } from './printerTestPage.js';

describe('createPrinterTestPage', () => {
  it('creates a locally generated PDF with no customer document content', async () => {
    const pdf = await createPrinterTestPage({
      printerLabel: 'Counter printer',
      paperSize: 'A4',
      color: false,
      duplex: false,
      bin: 'Tray 1',
    });

    expect(pdf.subarray(0, 4).toString('utf8')).toBe('%PDF');
    expect(pdf.toString('utf8')).not.toContain('customer');
  });
});
