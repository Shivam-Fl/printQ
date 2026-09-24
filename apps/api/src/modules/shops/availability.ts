import { prisma } from '../../lib/prisma.js';
import { notifyStudent } from '../../providers/notification/index.js';

/** Printer profiles are sellable only while an online agent can reach them. */
export async function reachablePrinterIds(shopId: string): Promise<Set<string>> {
  const agents = await prisma.agent.findMany({
    where: { shopId, status: 'online' },
    select: { connectedPrinterIds: true },
  });
  return new Set(agents.flatMap((agent) => agent.connectedPrinterIds));
}

export async function isShopOperational(shopId: string): Promise<boolean> {
  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { acceptingOrders: true, latitude: true, longitude: true },
  });
  if (!shop?.acceptingOrders || shop.latitude == null || shop.longitude == null) return false;
  const reachable = await reachablePrinterIds(shopId);
  if (reachable.size === 0) return false;
  return (
    (await prisma.printer.count({
      where: { shopId, id: { in: [...reachable] }, status: 'online' },
    })) > 0
  );
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
