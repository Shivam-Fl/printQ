import { Router } from 'express';
import { prisma } from '../../lib/prisma.js';
import { asyncHandler, conflict, notFound } from '../../lib/errors.js';
import { param } from '../../lib/http.js';
import { requireAgent } from '../../middleware/auth.js';
import { storage } from '../../providers/storage/index.js';
import { publishEvent } from '../../realtime/events.js';
import { applyTransition } from '../jobs/transitions.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { logger } from '../../lib/logger.js';

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
      select: { id: true, assignedPrinterId: true, specs: true },
    });
    res.json({ jobs });
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
    });
    if (!job) throw conflict('Job state changed');

    publishEvent(`student:${job.studentId}`, 'job:update', { jobId: job.id, status: 'printing' });
    publishEvent(`shop:${job.shopId}`, 'queue:job_printing', { jobId: job.id });
    res.json({
      job: { id: job.id, printerId: job.assignedPrinterId, specs: job.specs },
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
    });
    if (!updated) throw conflict('Job state changed');

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
      { claimedByAgentId: null },
    );
    if (!updated) throw conflict('Job state changed');

    logger.warn({ jobId: job.id, agentId: agent.id, reason }, 'print_failed');
    publishEvent(`shop:${job.shopId}`, 'queue:print_failed', { jobId: job.id, reason });
    res.json({ ok: true });
  }),
);
