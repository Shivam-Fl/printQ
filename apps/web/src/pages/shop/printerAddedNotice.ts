/** What the Printers page says right after a printer is added or linked (DOM-free so it is unit-tested). */
import { isSimulatorPrinterName, simulatorOnly, statusBanner, type SetupSnapshot } from '../../lib/setupSteps.js';

export { isSimulatorPrinterName };

export interface SetupAfterAdd extends SetupSnapshot {
  studentUrl?: string;
}

export interface AfterPrinterAdded {
  kind: 'live' | 'practice' | 'next';
  title: string;
  text: string;
  to: string;
  action: string;
  /** The student ordering page, only once the shop is live. */
  studentUrl: string | null;
}

/**
 * `addedName` is the Windows printer name just added. An older API without simulatorPrinters counts
 * the simulator as a normal printer, so there the name tells us it is the only (practice) printer.
 */
export function afterPrinterAdded(setup: SetupAfterAdd, addedName?: string | null): AfterPrinterAdded {
  const practice = setup.counts.simulatorPrinters === undefined
    ? isSimulatorPrinterName(addedName) && setup.counts.linkedPrinters <= 1
    : simulatorOnly(setup.counts);
  if (practice) {
    return {
      kind: 'practice',
      title: 'Simulator added — for practice only',
      text: 'The simulator never prints and never takes real student orders. Add your real printer to go live.',
      to: '/dashboard/agents',
      action: 'Connect your real printer',
      studentUrl: null,
    };
  }
  const banner = statusBanner(setup);
  if (!banner) {
    return {
      kind: 'live',
      title: 'Printer added — your shop is live',
      text: 'Students nearby can find you and send jobs now. Put your QR code at the counter so they can order.',
      to: '/dashboard/setup',
      action: 'Get your QR code',
      studentUrl: setup.studentUrl ?? null,
    };
  }
  return { kind: 'next', title: 'Printer added', text: banner.text, to: banner.to, action: banner.action, studentUrl: null };
}
