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
