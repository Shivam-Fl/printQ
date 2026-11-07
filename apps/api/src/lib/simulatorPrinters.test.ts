import { afterEach, describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { canPrintForStudents, simulatorIsPracticeOnly } from './simulatorPrinters.js';

const saved = { NODE_ENV: env.NODE_ENV, ALLOW: env.ALLOW_SIMULATED_PRINT_COMPLETION };
afterEach(() => {
  env.NODE_ENV = saved.NODE_ENV;
  env.ALLOW_SIMULATED_PRINT_COMPLETION = saved.ALLOW;
});

describe('simulator printers (PSO-1)', () => {
  it('are practice only in production, where simulated completion is refused', () => {
    env.NODE_ENV = 'production';
    env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
    expect(simulatorIsPracticeOnly()).toBe(true);
    expect(canPrintForStudents({ osPrinterName: 'PrintQ Simulator' })).toBe(false);
    expect(canPrintForStudents({ osPrinterName: '  printq simulator ' })).toBe(false);
    expect(canPrintForStudents({ osPrinterName: 'HP LaserJet M1005' })).toBe(true);
    expect(canPrintForStudents({ osPrinterName: null })).toBe(true);
  });

  it('keep working end to end in development and tests', () => {
    env.NODE_ENV = 'development';
    env.ALLOW_SIMULATED_PRINT_COMPLETION = false;
    expect(simulatorIsPracticeOnly()).toBe(false);
    env.NODE_ENV = 'test';
    env.ALLOW_SIMULATED_PRINT_COMPLETION = true;
    expect(simulatorIsPracticeOnly()).toBe(false);
    expect(canPrintForStudents({ osPrinterName: 'PrintQ Simulator' })).toBe(true);
  });

  it('takes an explicit mode for callers that already decided it', () => {
    expect(canPrintForStudents({ osPrinterName: 'PrintQ Simulator' }, true)).toBe(false);
    expect(canPrintForStudents({ osPrinterName: 'PrintQ Simulator' }, false)).toBe(true);
  });
});
