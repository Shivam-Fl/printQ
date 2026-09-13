import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireAgent } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { storage } from '../../providers/storage/index.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition } from '../jobs/transitions.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { logger } from '../../lib/logger.js';
import { advanceShopQueues, emitQueueUpdate } from '../queue/engine.js';
import { notifyShopReopened } from '../shops/availability.js';
import { creditPrintEarning } from '../earnings/service.js';

export const agentRouter = Router();
agentRouter.use(requireAgent);

/** Liveness ping — the dashboard shows agents red after missed heartbeats. */
agentRouter.post(
  '/heartbeat',
  asyncHandler(async (req, res) => {
    await prisma.agent.update({
      where: { id: req.agent!.id },
      data: { lastHeartbeatAt: new Date(), status: 'online' },
    });
    res.json({ ok: true });
  }),
);

const detectedPrintersSchema = z.object({
  printers: z
    .array(z.object({ name: z.string().trim().min(1).max(200), paperSizes: z.array(z.string()).default([]) }))
    .max(50),
});

/**
 * Reported by the agent from getPrinters() on connect + every heartbeat —
 * replaces the old hand-typed PRINTER_MAP: the dashboard shows this list so
 * the owner links a PrintQ printer profile to a real OS printer with one click.
 */
agentRouter.post(
  '/printers',
  validateBody(detectedPrintersSchema),
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const { printers } = req.body as { printers: { name: string; paperSizes: string[] }[] };

    // Auto-topology: any PrintQ printer already linked (by osPrinterName) to one
    // of the names this PC can see is reachable from here — no manual "which
    // printers can this PC reach" step needed for the common case. Owners can
    // still override via PATCH /shop/agents/:id.
    const names = printers.map((p) => p.name);
    const reachable = names.length
      ? await prisma.printer.findMany({
          where: { shopId: agent.shopId, osPrinterName: { in: names } },
          select: { id: true },
        })
      : [];
    const connectedPrinterIds = [...new Set([...agent.connectedPrinterIds, ...reachable.map((p) => p.id)])];

    await prisma.agent.update({
      where: { id: agent.id },
      data: { detectedPrinters: printers, detectedAt: new Date(), connectedPrinterIds },
    });
    await advanceShopQueues(agent.shopId);
    await emitQueueUpdate(agent.shopId);
    await notifyShopReopened(agent.shopId);
    publishEvent(`shop:${agent.shopId}`, 'agent:printers_detected', { agentId: agent.id, printers });
    res.json({ ok: true });
  }),
);

/**
 * Dispatch recovery: jobs verified while the agent was offline. Scoped to
 * printers this agent can reach, unclaimed or claimed by itself.
 */
agentRouter.get(
  '/jobs/pending',
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const jobs = await prisma.job.findMany({
      where: {
        shopId: agent.shopId,
        status: 'otp_verified',
        assignedPrinterId: { in: agent.connectedPrinterIds },
        OR: [{ claimedByAgentId: null }, { claimedByAgentId: agent.id }],
      },
      select: {
        id: true,
        assignedPrinterId: true,
        specs: true,
        assignedPrinter: { select: { osPrinterName: true } },
      },
    });
    res.json({
      jobs: jobs.map((j) => ({
        id: j.id,
        assignedPrinterId: j.assignedPrinterId,
        specs: j.specs,
        osPrinterName: j.assignedPrinter?.osPrinterName ?? null,
      })),
    });
  }),
);

/**
 * First agent to claim wins (many-to-many topology, printQ.md §6.3): the
 * conditional update is the lock — a second claim finds count 0 and backs off.
 */
agentRouter.post(
  '/jobs/:id/claim',
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const claimed = await prisma.job.updateMany({
      where: {
        id: param(req, 'id'),
        shopId: agent.shopId,
        status: 'otp_verified',
        assignedPrinterId: { in: agent.connectedPrinterIds },
        OR: [{ claimedByAgentId: null }, { claimedByAgentId: agent.id }],
      },
      data: { claimedByAgentId: agent.id },
    });
    if (claimed.count === 0) throw conflict('Job already claimed or not printable');

    const job = await applyTransition(param(req, 'id'), 'otp_verified', 'PRINT_STARTED', {
      type: 'agent',
      id: agent.id,
    }, { printError: null, printAttempts: { increment: 1 } });
    if (!job) throw conflict('Job state changed');

    const printer = job.assignedPrinterId
      ? await prisma.printer.findUnique({
          where: { id: job.assignedPrinterId },
          select: { osPrinterName: true },
        })
      : null;

    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'printing' });
    publishEvent(`shop:${job.shopId}`, 'queue:job_printing', { jobId: job.id });
    res.json({
      job: {
        id: job.id,
        printerId: job.assignedPrinterId,
        specs: job.specs,
        osPrinterName: printer?.osPrinterName ?? null,
      },
    });
  }),
);

/** The converted, print-ready PDF for a job this agent has claimed. */
agentRouter.get(
  '/jobs/:id/file',
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const job = await prisma.job.findFirst({
      where: {
        id: param(req, 'id'),
        shopId: agent.shopId,
        claimedByAgentId: agent.id,
        status: { in: ['otp_verified', 'printing'] },
      },
      include: { file: true },
    });
    if (!job || !job.file.convertedKey) throw notFound();

    const bytes = await storage.get(job.file.convertedKey);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${job.id}.pdf"`);
    res.send(bytes);
  }),
);

agentRouter.post(
  '/jobs/:id/complete',
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), shopId: agent.shopId, claimedByAgentId: agent.id },
    });
    if (!job) throw notFound();
    if (job.status !== 'printing') throw conflict('Job is not printing');

    const updated = await applyTransition(job.id, 'printing', 'PRINT_COMPLETED', {
      type: 'agent',
      id: agent.id,
    }, { printError: null });
    if (!updated) throw conflict('Job state changed');

    // Printing is the earning event—not upload, payment, queueing or handover.
    // The upsert is idempotent; the maintenance reconciler repairs a rare
    // database interruption without making the physical print fail again.
    await creditPrintEarning(updated.id).catch((error) => {
      logger.error({ error, jobId: updated.id }, 'shop_earning_credit_deferred');
    });

    await notifyStudent(job.studentId, {
      title: 'Print ready ✓',
      body: 'Collect it at the counter.',
      url: `/jobs/${job.id}`,
    });
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: 'ready_for_pickup',
    });
    publishEvent(`shop:${job.shopId}`, 'queue:job_ready', { jobId: job.id });
    res.json({ ok: true });
  }),
);

/** Print failed (jam, offline spooler) — job returns to otp_verified for re-dispatch. */
agentRouter.post(
  '/jobs/:id/fail',
  asyncHandler(async (req, res) => {
    const agent = req.agent!;
    const job = await prisma.job.findFirst({
      where: { id: param(req, 'id'), shopId: agent.shopId, claimedByAgentId: agent.id },
    });
    if (!job) throw notFound();
    if (job.status !== 'printing') throw conflict('Job is not printing');

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : 'unknown';
    const updated = await applyTransition(
      job.id,
      'printing',
      'PRINT_FAILED',
      { type: 'agent', id: agent.id },
      { claimedByAgentId: null, printError: reason },
    );
    if (!updated) throw conflict('Job state changed');

    logger.warn({ jobId: job.id, agentId: agent.id, reason }, 'print_failed');
    publishEvent(`student:${job.studentId}`, 'job:update', {
      jobId: job.id,
      status: 'otp_verified',
    });
    publishEvent(`shop:${job.shopId}`, 'queue:print_failed', { jobId: job.id, reason });
    res.json({ ok: true });
  }),
);
