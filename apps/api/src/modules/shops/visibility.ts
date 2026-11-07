import { isSimulatorPrinterName } from '@printq/shared';
import { isPublishedShop } from '../public/discovery.js';
import { canPrintForStudents, simulatorIsPracticeOnly } from '../../lib/simulatorPrinters.js';

/**
 * What students can see of this shop right now, kept apart from "is setup
 * complete". A published shop whose counter PC is off at night is still live
 * (`live_pc_offline`); the owner must not be told to finish setup.
 */
export type ShopVisibilityState =
  | 'live'
  | 'live_pc_offline'
  | 'not_ready'
  | 'hidden_by_admin'
  | 'campus_inactive'
  | 'pending_review';

export interface ShopVisibility {
  state: ShopVisibilityState;
  /** Only for hidden_by_admin, and only when the admin recorded one. */
  reason: string | null;
}

export interface ShopVisibilityInput {
  autoLive: boolean;
  verificationStatus: string;
  publishedAt: Date | null;
  campusId: string | null;
  campus?: { isActive: boolean } | null;
  latitude: number | null;
  longitude: number | null;
  /** An online agent reaches an online printer right now (the public "open" printer rule). */
  printerPathOnline: boolean;
  /** Latest admin publish/unpublish/verify/reject audit event for this shop, if any. */
  lastAdminAction: { action: string; metadata: unknown } | null;
}

/** Admin audit actions that decide whether an unpublished, verified shop was hidden on purpose. */
export const VISIBILITY_ADMIN_ACTIONS = ['shop.published', 'shop.unpublished', 'shop.verified', 'shop.rejected'];

function recordedReason(event: { metadata: unknown } | null): string | null {
  const reason = (event?.metadata as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 300) : null;
}

/** Same publication rule as public discovery (publishedShopWhere), plus the hide reasons. */
export function shopVisibility(shop: ShopVisibilityInput): ShopVisibility {
  const last = shop.lastAdminAction;
  if (shop.verificationStatus === 'rejected') {
    return { state: 'hidden_by_admin', reason: last?.action === 'shop.rejected' ? recordedReason(last) : null };
  }
  if (shop.verificationStatus === 'verified' && !shop.publishedAt && last?.action === 'shop.unpublished') {
    return { state: 'hidden_by_admin', reason: recordedReason(last) };
  }
  // A shop on an inactive campus is 404 to students whatever else is true.
  if (shop.campusId != null && shop.campus?.isActive !== true) return { state: 'campus_inactive', reason: null };
  if (isPublishedShop(shop)) {
    if (shop.latitude == null || shop.longitude == null) return { state: 'not_ready', reason: null };
    return { state: shop.printerPathOnline ? 'live' : 'live_pc_offline', reason: null };
  }
  // Legacy manual review: submitted, or verified and waiting for the admin to publish.
  if ((shop.verificationStatus === 'submitted' && !shop.autoLive) || shop.verificationStatus === 'verified') {
    return { state: 'pending_review', reason: null };
  }
  return { state: 'not_ready', reason: null };
}

/**
 * True when an online agent is connected to an online printer (same rule as the public "open" flag).
 * In production the simulator printer does not count (PSO-1).
 */
export function hasOnlinePrinterPath(
  agents: { status: string; connectedPrinterIds: string[] }[],
  printers: { id: string; status: string; osPrinterName?: string | null }[],
  practiceOnly = simulatorIsPracticeOnly(),
): boolean {
  const reachable = new Set(agents.filter((agent) => agent.status === 'online').flatMap((agent) => agent.connectedPrinterIds));
  return printers.some((printer) => printer.status === 'online' && reachable.has(printer.id) && canPrintForStudents(printer, practiceOnly));
}

/**
 * OS printers that this shop's ONLINE agents can see but that no PrintQ printer
 * profile is linked to yet ("PC connected · 1 printer found — add it").
 * In production the simulator is not offered: adding it would not take the shop live.
 */
export function countDetectedPrinters(
  agents: { status: string; detectedPrinters: unknown }[],
  printers: { osPrinterName: string | null }[],
  practiceOnly = simulatorIsPracticeOnly(),
): number {
  const linked = new Set(printers.map((printer) => printer.osPrinterName).filter((name): name is string => Boolean(name)));
  const found = new Set<string>();
  for (const agent of agents) {
    if (agent.status !== 'online' || !Array.isArray(agent.detectedPrinters)) continue;
    for (const item of agent.detectedPrinters as { name?: unknown }[]) {
      if (typeof item?.name !== 'string' || !item.name || linked.has(item.name)) continue;
      if (practiceOnly && isSimulatorPrinterName(item.name)) continue;
      found.add(item.name);
    }
  }
  return found.size;
}
