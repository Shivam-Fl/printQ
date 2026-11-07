/**
 * The printer name the agent reports in simulation mode (`--simulate`).
 * The API uses it to tell a test-only computer apart from a real printer.
 */
export const SIMULATOR_PRINTER_NAME = 'PrintQ Simulator' as const;
export type SimulatorPrinterName = typeof SIMULATOR_PRINTER_NAME;

/** True for the simulator printer, ignoring case and surrounding spaces. */
export function isSimulatorPrinterName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.trim().toLowerCase() === SIMULATOR_PRINTER_NAME.toLowerCase();
}
