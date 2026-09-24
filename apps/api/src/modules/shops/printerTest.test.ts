import { describe, expect, it } from 'vitest';
import { selectPrinterTestAgent } from './printerTest.js';

describe('selectPrinterTestAgent', () => {
  const agents = [
    { id: 'online-owner', status: 'online', connectedPrinterIds: ['printer-1'] },
    { id: 'offline-owner', status: 'offline', connectedPrinterIds: ['printer-1'] },
    { id: 'online-other', status: 'online', connectedPrinterIds: ['printer-2'] },
  ] as const;

  it('allows only an online agent that is linked to the requested printer', () => {
    expect(selectPrinterTestAgent(agents, 'printer-1', 'online-owner')).toEqual(agents[0]);
    expect(selectPrinterTestAgent(agents, 'printer-1', 'offline-owner')).toBeNull();
    expect(selectPrinterTestAgent(agents, 'printer-1', 'online-other')).toBeNull();
  });

  it('does not guess when more than one computer can reach the printer', () => {
    expect(selectPrinterTestAgent([
      agents[0],
      { id: 'another-online-owner', status: 'online', connectedPrinterIds: ['printer-1'] },
    ], 'printer-1')).toBeNull();
  });
});
