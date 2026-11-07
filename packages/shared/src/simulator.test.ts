import { describe, expect, it } from 'vitest';
import { SIMULATOR_PRINTER_NAME, isSimulatorPrinterName } from './simulator.js';

describe('isSimulatorPrinterName', () => {
  it('matches the name the agent reports', () => {
    expect(SIMULATOR_PRINTER_NAME).toBe('PrintQ Simulator');
    expect(isSimulatorPrinterName('PrintQ Simulator')).toBe(true);
    expect(isSimulatorPrinterName('  printq simulator ')).toBe(true);
  });

  it('does not match real printers or empty values', () => {
    expect(isSimulatorPrinterName('HP LaserJet M1005')).toBe(false);
    expect(isSimulatorPrinterName('PrintQ Simulator 2')).toBe(false);
    expect(isSimulatorPrinterName('')).toBe(false);
    expect(isSimulatorPrinterName(null)).toBe(false);
    expect(isSimulatorPrinterName(undefined)).toBe(false);
  });
});
