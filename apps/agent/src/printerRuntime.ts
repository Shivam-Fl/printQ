import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

export interface DetectedPrinter {
  name: string;
  paperSizes: string[];
}

export interface PrintOptions {
  printer: string;
  copies: number;
  duplex: boolean;
  color: boolean;
  jobId: string;
}

const failedOnce = new Set<string>();

export function isSimulationMode(): boolean {
  return process.argv.includes('--simulate') || process.env.PRINTQ_AGENT_MODE === 'simulate';
}

function simulatedPrinters(): DetectedPrinter[] {
  const configured = process.env.PRINTQ_SIMULATED_PRINTERS;
  if (configured) {
    try {
      const parsed = JSON.parse(configured) as DetectedPrinter[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fall through to the safe default; startup should remain easy.
    }
  }
  return [{ name: 'PrintQ Simulator', paperSizes: ['A4', 'A3'] }];
}

export async function detectPrinters(): Promise<DetectedPrinter[]> {
  if (isSimulationMode()) return simulatedPrinters();
  const printer = (await import('pdf-to-printer')).default;
  return (await printer.getPrinters()).map((item) => ({
    name: item.name,
    paperSizes: item.paperSizes,
  }));
}

/**
 * Real mode delegates to the Windows spooler. Simulation mode exercises the
 * same download/claim/complete flow, optionally preserves the PDF as evidence,
 * and can fail the first attempt to prove retry recovery without hardware.
 */
export async function sendToPrinter(pdfPath: string, options: PrintOptions): Promise<void> {
  if (!isSimulationMode()) {
    const printer = (await import('pdf-to-printer')).default;
    await printer.print(pdfPath, {
      printer: options.printer,
      copies: options.copies,
      side: options.duplex ? 'duplex' : 'simplex',
      monochrome: !options.color,
    });
    return;
  }

  const outputDir = process.env.PRINTQ_SIM_OUTPUT_DIR;
  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    await copyFile(pdfPath, path.join(outputDir, `${options.jobId}.pdf`));
  }

  const delayMs = Math.max(0, Math.min(30_000, Number(process.env.PRINTQ_SIM_DELAY_MS ?? 800)));
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  if (process.env.PRINTQ_SIM_FAIL_FIRST === 'true' && !failedOnce.has(options.jobId)) {
    failedOnce.add(options.jobId);
    throw new Error('simulated printer jam on first attempt');
  }
}
