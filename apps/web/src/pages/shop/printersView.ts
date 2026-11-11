/** Pure helpers behind the shop Printers page (kept out of the component so they are unit-tested). */

/** Best-effort A4/A3 guess from what the OS driver reports. */
export function guessPaperSizes(reported: string[]): string[] {
  const has = (needle: string) => reported.some((s) => s.toLowerCase().includes(needle));
  const sizes: string[] = [];
  if (has('a3')) sizes.push('A3');
  if (sizes.length === 0 || has('a4') || has('letter')) sizes.unshift('A4');
  return sizes.length ? sizes : ['A4'];
}

export interface EmptyStateCopy {
  title: string;
  body: string;
  /** Show the "Connect a computer" button. */
  connect: boolean;
}

/** What the "Detected printers" box says when there is nothing new to add. */
export function detectedEmptyState(input: { agentsOnline: number; agentsTotal: number; linkedPrinters: number }): EmptyStateCopy {
  if (input.agentsOnline > 0 && input.linkedPrinters > 0) {
    return {
      title: 'All printers are added',
      body: 'Every printer your counter PC found is in the list below. A new printer will show up here by itself.',
      connect: false,
    };
  }
  if (input.agentsOnline > 0) {
    return {
      title: 'No printer found yet',
      body: 'Your counter PC is connected but has not found a printer. Switch the printer on and check it is installed in Windows.',
      connect: false,
    };
  }
  if (input.agentsTotal > 0) {
    return {
      title: 'Counter PC is offline',
      body: 'Turn on the counter PC and open PrintQs on it. Its printers will appear here.',
      connect: true,
    };
  }
  return {
    title: 'No printers found',
    body: 'Connect a counter computer first. Any installed printer will appear here automatically.',
    connect: true,
  };
}

export interface DetectedPrinterLite {
  name: string;
  paperSizes: string[];
}

/** Every OS printer an online or offline PC reported that is not added to PrintQs yet (one entry per name). */
export function unlinkedDetectedPrinters(
  agents: { detectedPrinters: DetectedPrinterLite[] | null }[],
  printers: { osPrinterName: string | null }[],
): DetectedPrinterLite[] {
  const linked = new Set(printers.map((p) => p.osPrinterName).filter(Boolean));
  const byName = new Map<string, DetectedPrinterLite>();
  for (const a of agents) {
    for (const d of a.detectedPrinters ?? []) {
      if (!linked.has(d.name)) byName.set(d.name, d);
    }
  }
  return [...byName.values()];
}

/**
 * Practice mode: every added printer is the practice simulator. Computed from the printers
 * themselves, so the warning survives a reload (it used to vanish once the simulator was added).
 */
export function practiceOnly(printers: { osPrinterName: string | null }[], isSimulator: (name: string | null) => boolean): boolean {
  const linked = printers.filter((p) => p.osPrinterName);
  return linked.length > 0 && linked.every((p) => isSimulator(p.osPrinterName));
}
