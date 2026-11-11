/**
 * Copy and routing rules for the shop setup checklist and the queue's setup banner.
 * Built from GET /api/shop/setup-status; DOM-free so it is unit-testable.
 */
import { currentPcPageUrl, displayUrl } from './pcDownload.js';

export type VisibilityState =
  | 'live'
  | 'live_pc_offline'
  | 'not_ready'
  | 'hidden_by_admin'
  | 'campus_inactive'
  | 'pending_review';

export interface SetupSnapshot {
  locationReady: boolean;
  pricingReady: boolean;
  printerReady: boolean;
  agentReady: boolean;
  ready: boolean;
  counts: {
    linkedPrinters: number;
    onlinePrinters: number;
    agents: number;
    onlineAgents: number;
    /** OS printers an online PC reported that are not added to PrintQs yet. */
    detectedPrinters?: number;
    /**
     * Added 'PrintQ Simulator' printers that cannot print for students (production). They are NOT
     * included in linkedPrinters / onlinePrinters. Missing on older APIs, and 0 in development.
     */
    simulatorPrinters?: number;
  };
  platformMarkupBps?: number;
  visibility?: { state: VisibilityState; reason: string | null };
  verification?: { publishedAt: string | null };
}

export const PRICES_PATH = '/dashboard/prices';

/** What students see right now. Falls back to ready/publishedAt if the API has no `visibility` yet. */
export function visibilityState(setup: Pick<SetupSnapshot, 'ready' | 'visibility' | 'verification'>): VisibilityState {
  if (setup.visibility) return setup.visibility.state;
  if (setup.ready) return 'live';
  return setup.verification?.publishedAt ? 'live_pc_offline' : 'not_ready';
}

/** The shop is in student search (even if its PC is off for the night). */
export function isListed(state: VisibilityState): boolean {
  return state === 'live' || state === 'live_pc_offline';
}

/** A shop that has never gone live belongs on the setup checklist, not the queue. */
export function stillOnboarding(state: VisibilityState): boolean {
  return state === 'not_ready' || state === 'pending_review';
}

export interface NextAction {
  text: string;
  to: string;
  action: string;
}

const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The practice printer's name and the API's matching rule. Subpath import keeps zod off the dashboard bundle.
export { SIMULATOR_PRINTER_NAME, isSimulatorPrinterName } from '@printq/shared/simulator';

export const SIMULATOR_ONLY_TEXT = 'Simulator connected — this is for practice. Add your real printer to go live.';

/** The only added printer is the practice simulator, which never prints real student orders. */
export function simulatorOnly(counts: Pick<SetupSnapshot['counts'], 'linkedPrinters' | 'simulatorPrinters'>): boolean {
  return (counts.simulatorPrinters ?? 0) > 0 && counts.linkedPrinters === 0;
}

/** Step 3: what the counter PC and printer still need. Null once a real linked printer is online. */
export function pcStepTodo(setup: Pick<SetupSnapshot, 'agentReady' | 'counts'>): NextAction | null {
  if (simulatorOnly(setup.counts) && setup.counts.onlineAgents > 0) {
    return { text: SIMULATOR_ONLY_TEXT, to: '/dashboard/printers', action: 'Add real printer' };
  }
  if (setup.agentReady) return null;
  const { agents, onlineAgents, linkedPrinters, detectedPrinters } = setup.counts;
  if (onlineAgents === 0) {
    return agents === 0
      ? {
        // same story as the /pc page: open the short link on the counter computer
        text: `On your counter PC (the Windows computer next to your printer), open ${displayUrl(currentPcPageUrl())}. Install PrintQs Shop and sign in there.`,
        to: '/dashboard/agents',
        action: 'Install on counter PC',
      }
      : { text: 'Your counter PC is offline. Turn it on and open PrintQs Shop.', to: '/dashboard/agents', action: 'Check counter PC' };
  }
  if (linkedPrinters === 0) {
    if (detectedPrinters === 0) {
      return {
        text: 'PC connected · no printer found yet. Switch the printer on and check it is installed in Windows.',
        to: '/dashboard/printers',
        action: 'Open printers',
      };
    }
    const found = detectedPrinters ? ` · ${count(detectedPrinters, 'printer')} found` : '';
    return { text: `PC connected${found}. Add it so students can send you jobs.`, to: '/dashboard/printers', action: 'Add printer' };
  }
  return {
    text: 'PC connected, but your printer is offline. Switch it on and check it is ready in Windows.',
    to: '/dashboard/printers',
    action: 'Check printers',
  };
}

/**
 * One plain line about the platform fee, e.g. 2500 bps -> "...fee of 25%." Null when there is no fee or it is unknown.
 * The exact student price per paper is shown next to each price in Settings (the Review link goes there).
 */
export function platformFeeLine(bps: number | undefined): string | null {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return null;
  return `Students pay your price + a PrintQs fee of ${Number((bps / 100).toFixed(2))}%.`;
}

export interface SetupStepView {
  key: 'location' | 'prices' | 'pc' | 'live';
  number: string;
  title: string;
  body: string;
  /** Extra line under the body (the platform fee on the prices step). */
  note?: string | null;
  done: boolean;
  to?: string;
  action?: string;
}

function liveStepBody(state: VisibilityState): string {
  switch (state) {
    case 'live': return 'Students nearby can find your shop and send jobs.';
    case 'live_pc_offline': return 'Your shop is listed, but students can’t order until the counter PC is back on.';
    case 'hidden_by_admin': return 'PrintQs has paused your shop. See the note above.';
    case 'campus_inactive': return 'Your campus is switched off, so students can’t find you right now. See the note above.';
    case 'pending_review': return 'PrintQs checks your shop, then students nearby can find you.';
    default: return 'Students nearby can find you as soon as your PC is connected and your printer is added.';
  }
}

/**
 * The three setup steps plus the "live" status card (not counted as a step).
 * Step 3 reads the live PC/printer counts so it never claims more than is true.
 */
export function setupSteps(setup: SetupSnapshot): SetupStepView[] {
  const state = visibilityState(setup);
  const pc = pcStepTodo(setup);
  return [
    {
      key: 'location',
      number: '01',
      title: 'Confirm your location',
      body: 'We try to find you automatically. Check the pin and address, then save.',
      done: setup.locationReady,
    },
    {
      key: 'prices',
      number: '02',
      title: 'Check your prices',
      body: 'Sensible defaults are already filled in. Keep them or change paper, colour and binding prices.',
      note: platformFeeLine(setup.platformMarkupBps),
      done: setup.pricingReady,
      to: PRICES_PATH,
      action: setup.pricingReady ? 'Review' : 'Set prices',
    },
    {
      key: 'pc',
      number: '03',
      title: 'Connect the counter PC and add your printer',
      body: pc ? pc.text : `PC connected · ${count(setup.counts.onlinePrinters, 'printer')} ready.`,
      done: !pc,
      to: pc ? pc.to : '/dashboard/printers',
      action: pc ? pc.action : 'Review',
    },
    {
      key: 'live',
      number: 'LIVE',
      title: 'You are live',
      body: liveStepBody(state),
      done: isListed(state),
    },
  ];
}

/** The first thing still missing, with the page that fixes it (never a loop back to an empty checklist). */
export function nextSetupAction(setup: SetupSnapshot): NextAction {
  if (!setup.locationReady) return { text: 'Save your shop location.', to: '/dashboard/setup', action: 'Save location' };
  if (!setup.pricingReady) return { text: 'Set your prices.', to: PRICES_PATH, action: 'Set prices' };
  const pc = pcStepTodo(setup);
  if (pc) return pc;
  if (visibilityState(setup) === 'pending_review') {
    return { text: 'PrintQs is checking your shop. Students can find you once it is approved.', to: '/dashboard/setup', action: 'View status' };
  }
  return { text: 'Everything is in place. Your shop shows to students in a few seconds.', to: '/dashboard/setup', action: 'View setup' };
}

export interface StatusBanner extends NextAction {
  title: string;
}

/**
 * Banner for a shop that is not fully live: a paused or offline live shop is told exactly that,
 * and only a shop that never finished setup sees "Finish setup". Null when live.
 */
export function statusBanner(setup: SetupSnapshot): StatusBanner | null {
  const state = visibilityState(setup);
  switch (state) {
    case 'live':
      // Listed, but the only printer is the simulator: real student orders would never print.
      return simulatorOnly(setup.counts)
        ? {
          title: 'Practice mode · only the simulator is connected',
          text: 'The simulator never prints real student orders. Add your real printer so orders can print.',
          to: '/dashboard/printers',
          action: 'Add real printer',
        }
        : null;
    case 'live_pc_offline': {
      const pc = setup.counts.onlineAgents > 0 ? pcStepTodo(setup) : null;
      return {
        title: pc
          ? 'Live · add a printer — students can’t order until one is ready'
          : 'Live · counter PC offline — students can’t order until it’s back on',
        text: pc?.text ?? 'Turn on the counter PC and open PrintQs Shop. Your shop stays listed, but shows as closed until then.',
        to: pc?.to ?? '/dashboard/agents',
        action: pc?.action ?? 'Check counter PC',
      };
    }
    case 'hidden_by_admin': {
      const reason = setup.visibility?.reason?.trim();
      return {
        title: 'Paused by PrintQs',
        text: reason
          ? `Students can’t find your shop right now. Reason: ${reason}. Contact support to get back online.`
          : 'Students can’t find your shop right now. Contact support to find out why and get back online.',
        to: '/support',
        action: 'Contact support',
      };
    }
    case 'campus_inactive':
      return {
        title: 'Hidden · your campus is switched off',
        text: 'PrintQs has switched off the campus your shop is listed under, so students can’t find you. Contact support and we will move your shop so it shows up again.',
        to: '/support',
        action: 'Contact support',
      };
    default: {
      const next = nextSetupAction(setup);
      const stepsDone = setup.locationReady && setup.pricingReady && !pcStepTodo(setup);
      if (stepsDone) {
        return { ...next, title: state === 'pending_review' ? 'Waiting for PrintQs review' : 'Almost live' };
      }
      return { title: 'Finish setup before accepting student orders', text: `Next: ${next.text}`, to: next.to, action: next.action };
    }
  }
}
