import { isSimulatorPrinterName } from '@printq/shared';
import { env } from '../config/env.js';

/**
 * PSO-1: production refuses simulated print completion (agents/routes.ts), so
 * there the built-in 'PrintQ Simulator' printer is practice only. It must never
 * make a shop go live, open it to students, or receive a student's order: the
 * order could never finish. Development (simulated completion allowed) keeps
 * using the simulator end to end.
 */
export function simulatorIsPracticeOnly(): boolean {
  return env.NODE_ENV === 'production' && !env.ALLOW_SIMULATED_PRINT_COMPLETION;
}

/** True when this printer can finish a student's order in this environment. */
export function canPrintForStudents(
  printer: { osPrinterName?: string | null },
  practiceOnly = simulatorIsPracticeOnly(),
): boolean {
  return !(practiceOnly && isSimulatorPrinterName(printer.osPrinterName));
}
