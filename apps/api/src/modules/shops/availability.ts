import { prisma } from '../../lib/prisma.js';
import { canPrintForStudents } from '../../lib/simulatorPrinters.js';
import { notifyStudent } from '../../providers/notification/index.js';

/** Printer profiles are sellable only while an online agent can reach them. */
export async function reachablePrinterIds(shopId: string): Promise<Set<string>> {
  const agents = await prisma.agent.findMany({
    where: { shopId, status: 'online' },
    select: { connectedPrinterIds: true },
  });
  return new Set(agents.flatMap((agent) => agent.connectedPrinterIds));
}

/** Shop columns + its ONLINE agents + its printers, as loaded in one joined query. */
export interface OperationalShopRows {
  acceptingOrders: boolean;
  feeBlockedAt: Date | null;
  latitude: number | null;
  longitude: number | null;
  agents: { connectedPrinterIds: string[] }[];
  /** osPrinterName is needed so the simulator never opens a shop in production (PSO-1). */
  printers: { id: string; status: string; osPrinterName: string | null }[];
}

/** Pure form of isShopOperational for callers that already loaded the rows (saves 3 round trips). */
export function isShopOperationalFrom(shop: OperationalShopRows | null | undefined): boolean {
  // A fee block cannot be bypassed by the owner's own acceptingOrders toggle.
  if (!shop?.acceptingOrders || shop.feeBlockedAt || shop.latitude == null || shop.longitude == null) return false;
  const reachable = new Set(shop.agents.flatMap((agent) => agent.connectedPrinterIds));
  return shop.printers.some((printer) => printer.status === 'online' && reachable.has(printer.id) && canPrintForStudents(printer));
}

export async function isShopOperational(shopId: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    relationLoadStrategy: 'join',
    select: {
      acceptingOrders: true,
      latitude: true,
      longitude: true,
      feeBlockedAt: true,
      agents: { where: { status: 'online' }, select: { connectedPrinterIds: true } },
      printers: { select: { id: true, status: true, osPrinterName: true } },
    },
  });
  return isShopOperationalFrom(shop);
}

/** Connect a printer profile to every registered PC that currently detects its OS name. */
export async function connectPrinterToDetectingAgents(
  shopId: string,
  printerId: string,
  osPrinterName: string,
): Promise<void> {
  const agents = await prisma.agent.findMany({ where: { shopId } });
  for (const agent of agents) {
    const detected = (agent.detectedPrinters as { name: string }[] | null) ?? [];
    if (
      detected.some((item) => item.name === osPrinterName) &&
      !agent.connectedPrinterIds.includes(printerId)
    ) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { connectedPrinterIds: [...agent.connectedPrinterIds, printerId] },
      });
    }
  }
}

/**
 * After a counter PC is removed: a printer that no remaining PC is connected to
 * cannot print, so it is switched offline (the Printers page and setup counts
 * stop calling it online). A printer another PC still reaches, even one that
 * is off for the night, is left alone. Returns how many were switched offline.
 */
export async function markUnreachablePrintersOffline(shopId: string, printerIds: string[]): Promise<number> {
  if (printerIds.length === 0) return 0;
  const remaining = await prisma.agent.findMany({ where: { shopId }, select: { connectedPrinterIds: true } });
  const stillReached = new Set(remaining.flatMap((agent) => agent.connectedPrinterIds));
  const orphaned = printerIds.filter((id) => !stillReached.has(id));
  if (orphaned.length === 0) return 0;
  const { count } = await prisma.printer.updateMany({
    where: { shopId, id: { in: orphaned }, status: 'online' },
    data: { status: 'offline' },
  });
  return count;
}

/**
 * The other half of markUnreachablePrintersOffline: when a PC links a printer
 * that no other PC reaches and it sits 'offline', switch it back online so a
 * re-installed PC opens the shop again without a trip to the Printers page.
 * 'jammed' and printers another PC already reaches (a staff choice) are kept.
 */
export async function restorePrintersReachedAgain(shopId: string, agentId: string, newlyConnectedIds: string[]): Promise<void> {
  if (newlyConnectedIds.length === 0) return;
  const others = await prisma.agent.findMany({
    where: { shopId, id: { not: agentId } },
    select: { connectedPrinterIds: true },
  });
  const reachedElsewhere = new Set(others.flatMap((agent) => agent.connectedPrinterIds));
  const firstLink = newlyConnectedIds.filter((id) => !reachedElsewhere.has(id));
  if (firstLink.length === 0) return;
  await prisma.printer.updateMany({
    where: { shopId, id: { in: firstLink }, status: 'offline' },
    data: { status: 'online' },
  });
}

/** Tell students waiting on a closed shop once the full printer path is live again. */
export async function notifyShopReopened(shopId: string): Promise<void> {
  if (!(await isShopOperational(shopId))) return;
  const shop = await prisma.shop.findUnique({ where: { id: shopId }, select: { name: true, slug: true } });
  if (!shop) return;
  const waiting = await prisma.shopOpenInterest.findMany({ where: { shopId }, select: { studentId: true } });
  if (waiting.length === 0) return;

  await Promise.all(
    waiting.map((entry) =>
      notifyStudent(entry.studentId, {
        title: `${shop.name} is open again`,
        body: 'Send your file now — the print station is connected.',
        url: `/s/${shop.slug}`,
        eventKey: `shop-reopened:${shopId}`,
      }),
    ),
  );
  await prisma.shopOpenInterest.deleteMany({ where: { shopId } });
}
