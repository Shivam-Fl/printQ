export interface PrinterTestAgent {
  id: string;
  status: 'online' | 'offline';
  connectedPrinterIds: readonly string[];
}

/**
 * A printer test must be sent to one known, online counter computer. We do
 * not broadcast it: two agents may both see the same printer and would print
 * two test pages. When there is more than one candidate, the dashboard makes
 * the staff member choose the physical computer.
 */
export function selectPrinterTestAgent(
  agents: readonly PrinterTestAgent[],
  printerId: string,
  requestedAgentId?: string,
): PrinterTestAgent | null {
  const candidates = agents.filter((agent) => (
    agent.status === 'online' && agent.connectedPrinterIds.includes(printerId)
  ));
  if (requestedAgentId) return candidates.find((agent) => agent.id === requestedAgentId) ?? null;
  return candidates.length === 1 ? candidates[0] ?? null : null;
}
