import type { JobSpecs, PrinterProfile, QueuedJobLite } from './types.js';

export interface PrinterRecommendation {
  printerId: string;
  /** minutes until this printer would finish the new job */
  estimatedWaitMinutes: number;
  queueLength: number;
}

export interface AssignmentResult {
  eligible: PrinterRecommendation[];
  /** best pick, or null when nothing eligible (caller must fall back to manual) */
  recommended: PrinterRecommendation | null;
}

function printerMatchesSpecs(printer: PrinterProfile, specs: JobSpecs): boolean {
  if (printer.status !== 'online') return false;
  if (!printer.paperSizesLoaded.includes(specs.paperSize)) return false;
  if (specs.color && !printer.colorSupport) return false;
  if (specs.binding && !printer.finishingOptions.includes(specs.binding)) return false;
  return true;
}

/**
 * Printer assignment (printQ.md §9): filter online + capability-matching
 * printers, rank by estimated completion time of the current queue plus the
 * new job. Runs regardless of the auto-assign toggle — only the action taken
 * with `recommended` differs.
 */
export function rankPrinters(
  printers: PrinterProfile[],
  specs: JobSpecs,
  jobPages: number,
  queuedJobs: QueuedJobLite[],
): AssignmentResult {
  const eligible: PrinterRecommendation[] = [];

  for (const printer of printers) {
    if (!printerMatchesSpecs(printer, specs)) continue;

    const queue = queuedJobs.filter((j) => j.assignedPrinterId === printer.id);
    const queuedPages = queue.reduce((sum, j) => sum + j.pages * j.copies, 0);
    const newJobPages = jobPages * specs.copies;
    const ppm = Math.max(printer.avgPagesPerMinute, 1);
    eligible.push({
      printerId: printer.id,
      estimatedWaitMinutes: Math.ceil((queuedPages + newJobPages) / ppm),
      queueLength: queue.length,
    });
  }

  eligible.sort(
    (a, b) => a.estimatedWaitMinutes - b.estimatedWaitMinutes || a.queueLength - b.queueLength,
  );

  return { eligible, recommended: eligible[0] ?? null };
}
