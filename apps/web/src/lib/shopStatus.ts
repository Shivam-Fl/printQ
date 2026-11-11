/**
 * One shared, tiny store for "what state is my shop in" so the nav's status chip,
 * the counter and the setup page agree without each fetching the same thing.
 * Pages that already load /api/shop/setup-status publish it here; the nav loads
 * it itself only when nothing fresh is known.
 */
import { setupSteps, simulatorOnly, visibilityState, type SetupSnapshot } from './setupSteps.js';

export interface ShopSetupStatus extends SetupSnapshot {
  acceptingOrders?: boolean;
}

export type ChipTone = 'ok' | 'warn' | 'danger';
export interface StatusChip {
  label: string;
  tone: ChipTone;
  to: string;
  /** Longer sentence for the title attribute / screen readers. */
  detail: string;
}

const STEP_COUNT = 3;

/** The nav's one-line shop status. Null while unknown. */
export function statusChip(setup: ShopSetupStatus | null): StatusChip | null {
  if (!setup) return null;
  const state = visibilityState(setup);
  switch (state) {
    case 'live':
      if (setup.acceptingOrders === false) {
        return { label: 'New orders paused', tone: 'warn', to: '/dashboard', detail: 'Students see your shop as closed. Resume on the Counter page.' };
      }
      if (simulatorOnly(setup.counts)) {
        return { label: 'Practice mode', tone: 'warn', to: '/dashboard/printers', detail: 'Only the practice simulator is connected. Add your real printer.' };
      }
      return { label: 'Live', tone: 'ok', to: '/dashboard/printers', detail: `Students can order. ${setup.counts.onlinePrinters} printer${setup.counts.onlinePrinters === 1 ? '' : 's'} ready.` };
    case 'live_pc_offline':
      return { label: 'Counter PC offline', tone: 'danger', to: '/dashboard/agents', detail: 'Students cannot order until the counter PC is back on and PrintQs Shop is open.' };
    case 'hidden_by_admin':
      return { label: 'Paused by PrintQs', tone: 'danger', to: '/dashboard/setup', detail: setup.visibility?.reason ? `Reason: ${setup.visibility.reason}` : 'Contact support to find out why.' };
    case 'campus_inactive':
      return { label: 'Hidden from students', tone: 'danger', to: '/dashboard/setup', detail: 'Your campus is switched off. Contact support.' };
    case 'pending_review':
      return { label: 'Waiting for review', tone: 'warn', to: '/dashboard/setup', detail: 'PrintQs is checking your shop.' };
    default: {
      // same count as the setup checklist, so the chip and the page never disagree
      const done = setupSteps(setup).filter((step) => step.key !== 'live' && step.done).length;
      return { label: `Setup ${Math.min(done, STEP_COUNT)} of ${STEP_COUNT}`, tone: 'warn', to: '/dashboard/setup', detail: 'Finish setup to start taking orders.' };
    }
  }
}

/** True once the shop has been live at least once (listed, even with the PC off). */
export function hasGoneLive(setup: ShopSetupStatus | null): boolean {
  if (!setup) return false;
  const state = visibilityState(setup);
  return state !== 'not_ready' && state !== 'pending_review';
}

type Listener = (setup: ShopSetupStatus | null) => void;
let current: ShopSetupStatus | null = null;
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<Listener>();

export const shopStatus = {
  get: () => current,
  /** Publish a fresh snapshot (pages that fetched setup-status themselves call this). */
  set(setup: ShopSetupStatus | null) {
    current = setup;
    loadedAt = Date.now();
    for (const l of listeners) l(current);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** Fetch only if nothing fresh is known; concurrent callers share one request. */
  async ensure(fetcher: () => Promise<ShopSetupStatus>, maxAgeMs = 30_000): Promise<void> {
    if (current && Date.now() - loadedAt < maxAgeMs) return;
    if (inFlight) return inFlight;
    inFlight = fetcher()
      .then((setup) => shopStatus.set(setup))
      .catch(() => undefined)
      .finally(() => { inFlight = null; });
    return inFlight;
  },
  /** Forget everything (sign out). */
  reset() {
    current = null;
    loadedAt = 0;
    for (const l of listeners) l(null);
  },
};
