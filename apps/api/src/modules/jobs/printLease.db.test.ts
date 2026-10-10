/**
 * D1: a job stuck in `printing` when its print computer dies / is revoked /
 * deleted must recover (lease sweep -> print-failed -> staff retry/cancel),
 * and must be printed (and commission-posted) exactly once.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../providers/notification/index.js', () => ({ notifyStudent: vi.fn(async () => undefined) }));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn(), subscribeEvents: vi.fn() }));

import { prisma } from '../../lib/prisma.js';
import { fileRetentionQueue, timersQueue } from '../../lib/queues.js';
import { drainBackground } from '../../lib/background.js';
import { generateAgentToken } from '../../lib/otp.js';
import { signShopToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { notifyStudent } from '../../providers/notification/index.js';
import { publishEvent } from '../../realtime/events.js';
import { shopRouter } from '../shops/routes.js';
import { agentRouter } from '../agents/routes.js';
import { failOrphanedPrints } from './printLease.js';

const dbReady = await (async () => {
  try {
    await prisma.job.findFirst({ select: { printConfirmedAt: true } });
    return true;
  } catch (error) {
    console.warn('printLease.db.test skipped: database not ready -', String(error).slice(0, 200));
    return false;
  }
})();

vi.setConfig({ testTimeout: 60_000 });

const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };
const OLD = () => new Date(Date.now() - 10 * 60_000);

describe.runIf(dbReady)('print lease recovery (database)', () => {
  let shopId = '';
  let studentId = '';
  let printerId = '';
  let ownerId = '';
  let shopToken = '';
  let server: Server;
  let base = '';
  const spies = [
    vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never),
    vi.spyOn(fileRetentionQueue, 'add').mockResolvedValue(undefined as never),
  ];

  async function makeAgent(opts: { alive: boolean; sessionId?: string }) {
    const { token, tokenHash } = generateAgentToken();
    const agent = await prisma.agent.create({
      data: {
        shopId, machineLabel: `PC-${randomUUID().slice(0, 4)}`, tokenHash,
        connectedPrinterIds: [printerId],
        status: opts.alive ? 'online' : 'offline',
        lastHeartbeatAt: opts.alive ? new Date() : OLD(),
        sessionId: opts.sessionId ?? null,
      },
    });
    return { agent, token };
  }

  async function printingJob(
    agentId: string | null,
    opts: { ageMs?: number; sessionId?: string | null; spooled?: boolean } = {},
  ) {
    const file = await prisma.uploadedFile.create({
      data: {
        studentId, shopId, originalName: 'doc.pdf', originalKey: `orig/${randomUUID()}.pdf`,
        convertedKey: `conv/${randomUUID()}.pdf`, mimeType: 'application/pdf', sizeBytes: 10, pages: 2,
        status: 'ready', deleteAfter: new Date(Date.now() + 24 * 3_600_000),
      },
    });
    const job = await prisma.job.create({
      data: {
        shopId, studentId, fileId: file.id, specs, pagesPerCopy: 2, priceBreakdown: {}, totalPaise: 500,
        shopBasePaise: 400,
        paymentProvider: 'pay_at_shop', paymentStatus: 'paid',
        counterPaymentMethod: 'cash', counterPaymentConfirmedAt: new Date(), counterPaymentAmountPaise: 500,
        status: 'printing', assignedPrinterId: printerId, claimedByAgentId: agentId, printAttempts: 1,
        claimedBySessionId: opts.sessionId ?? null,
        spoolAcceptedAt: opts.spooled ? new Date(Date.now() - (opts.ageMs ?? 600_000)) : null,
      },
    });
    // the claim happened long ago (default 10 min)
    await prisma.job.updateMany({
      where: { id: job.id },
      data: { updatedAt: new Date(Date.now() - (opts.ageMs ?? 600_000)) },
    });
    return job;
  }

  const shopCall = (path: string, method = 'POST', body: unknown = {}) =>
    fetch(`${base}/api/shop${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${shopToken}` },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  const agentCall = (token: string, path: string, method = 'POST', body: unknown = {}, session?: string) =>
    fetch(`${base}/api/agent${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-agent-token': token,
        ...(session ? { 'x-agent-session': session } : {}),
      },
      body: method === 'GET' ? undefined : JSON.stringify(body),
    });
  const fresh = (id: string) => prisma.job.findUniqueOrThrow({ where: { id } });
  const commissions = async (id: string) => { await drainBackground(); return prisma.shopCommissionEntry.count({ where: { jobId: id, type: 'print_commission' } }); };

  beforeAll(async () => {
    const shop = await prisma.shop.create({
      data: {
        slug: `lease-${randomUUID().slice(0, 8)}`, name: 'Lease shop', address: 'Test lane',
        latitude: 28.6, longitude: 77.2, rateCard: { bw: 100, color: 500 },
      },
    });
    shopId = shop.id;
    const printer = await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    printerId = printer.id;
    const owner = await prisma.shopUser.create({
      data: { shopId, email: `${randomUUID()}@lease.test`, passwordHash: 'x', name: 'Owner', role: 'owner' },
    });
    ownerId = owner.id;
    shopToken = signShopToken(ownerId, shopId, 'owner', owner.sessionVersion);
    const student = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Lease' },
    });
    studentId = student.id;
    const app = express();
    app.use(express.json());
    app.use('/api/shop', shopRouter);
    app.use('/api/agent', agentRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await drainBackground();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const jobs = await prisma.job.findMany({ where: { shopId }, select: { id: true } });
    const ids = jobs.map((j) => j.id);
    await prisma.shopCommissionEntry.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.paymentEvent.deleteMany({ where: { jobId: { in: ids } } });
    await prisma.job.deleteMany({ where: { id: { in: ids } } });
    await prisma.uploadedFile.deleteMany({ where: { studentId } });
    await prisma.agent.deleteMany({ where: { shopId } });
    await prisma.printer.deleteMany({ where: { shopId } });
    await prisma.shopUser.deleteMany({ where: { shopId } });
    await prisma.shop.delete({ where: { id: shopId } });
    await prisma.student.delete({ where: { id: studentId } });
    spies.forEach((s) => s.mockRestore());
  });

  it('agent dies mid-print: job fails after the lease, student + shop are told, then retry on another agent prints exactly once', async () => {
    const a = await makeAgent({ alive: false });
    const job = await printingJob(a.agent.id);
    const b = await makeAgent({ alive: true }); // a healthy second computer
    vi.mocked(notifyStudent).mockClear();

    await failOrphanedPrints();
    const failed = await fresh(job.id);
    expect(failed.status).toBe('otp_verified');
    expect(failed.claimedByAgentId).toBeNull();
    expect(failed.printError).toBe('agent_offline');
    const events = await prisma.jobEvent.findMany({ where: { jobId: job.id } });
    expect(events.some((e) => e.event === 'print_lease_expired' && e.actorType === 'system')).toBe(true);
    expect(notifyStudent).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(vi.mocked(notifyStudent).mock.calls[0]);
    expect(body).toContain('hit a problem');
    expect(body).not.toContain('agent_offline');
    expect(publishEvent).toHaveBeenCalledWith(`shop:${shopId}`, 'queue:print_failed', expect.objectContaining({ jobId: job.id, code: 'agent_offline' }));

    // the dead agent's pending list never re-prints it automatically
    const pending = await agentCall(a.token, '/jobs/pending', 'GET');
    expect(((await pending.json()) as { jobs: unknown[] }).jobs).toHaveLength(0);

    // the queue payload carries friendly text, never the raw code
    const queue = (await (await shopCall('/queue', 'GET')).json()) as { jobs: { id: string; printError: string | null; printErrorCode: string | null }[] };
    const row = queue.jobs.find((j) => j.id === job.id)!;
    expect(row.printErrorCode).toBe('agent_offline');
    // D2: the dashboard needs these to render the counter-refund (Payment returned) button
    expect((row as unknown as { counterPaymentConfirmedAt: string }).counterPaymentConfirmedAt).toBeTruthy();
    expect(row.printError).not.toContain('agent_offline');

    // staff retry -> another computer prints it once
    expect((await shopCall(`/jobs/${job.id}/retry-print`)).status).toBe(200);
    expect((await agentCall(b.token, `/jobs/${job.id}/claim`)).status).toBe(200);
    expect((await fresh(job.id)).printAttempts).toBe(2);
  });

  it('retry on another agent -> exactly one commission; late completion from the old agent is rejected with 409', async () => {
    const a = await makeAgent({ alive: false });
    const b = await makeAgent({ alive: true });
    const job = await printingJob(a.agent.id);
    await failOrphanedPrints();
    expect((await shopCall(`/jobs/${job.id}/retry-print`)).status).toBe(200);

    expect((await agentCall(b.token, `/jobs/${job.id}/claim`)).status).toBe(200);
    // old agent wakes up and reports its (stale) outcome: refused
    expect((await agentCall(a.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' })).status).toBe(409);
    expect((await agentCall(a.token, `/jobs/${job.id}/claim`)).status).toBe(409);
    expect((await fresh(job.id)).claimedByAgentId).toBe(b.agent.id);

    expect((await agentCall(b.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' })).status).toBe(200);
    // idempotent for the holder
    expect((await agentCall(b.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' })).status).toBe(200);
    expect((await shopCall(`/jobs/${job.id}/confirm-print-completion`)).status).toBe(200);
    expect((await shopCall(`/jobs/${job.id}/confirm-print-completion`)).status).toBe(409);
    expect((await fresh(job.id)).status).toBe('ready_for_pickup');
    expect(await commissions(job.id)).toBe(1);
  });

  it('a healthy agent (recent heartbeat) keeps its lease; a revoked/deleted agent loses it', async () => {
    const alive = await makeAgent({ alive: true });
    const keep = await printingJob(alive.agent.id, { ageMs: 30_000 });
    const doomed = await makeAgent({ alive: true });
    const lost = await printingJob(doomed.agent.id);
    await prisma.agent.delete({ where: { id: doomed.agent.id } }); // owner revokes / deletes the computer

    await failOrphanedPrints();
    expect((await fresh(keep.id)).status).toBe('printing');
    const after = await fresh(lost.id);
    expect(after.status).toBe('otp_verified');
    expect(after.printError).toBe('agent_offline');
  });

  it('staff can retry and cancel-and-return a printing job whose computer is offline; connected computer is refused', async () => {
    const live = await makeAgent({ alive: true });
    const guarded = await printingJob(live.agent.id, { ageMs: 30_000 });
    expect((await shopCall(`/jobs/${guarded.id}/retry-print`)).status).toBe(409);
    expect((await shopCall(`/jobs/${guarded.id}/counter-payment-returned`)).status).toBe(409);
    expect((await fresh(guarded.id)).status).toBe('printing');

    const gone = await makeAgent({ alive: false });
    const retryJob = await printingJob(gone.agent.id);
    await makeAgent({ alive: true });
    expect((await shopCall(`/jobs/${retryJob.id}/retry-print`)).status).toBe(200);
    expect((await fresh(retryJob.id)).status).toBe('otp_verified');

    const cancelJob = await printingJob(gone.agent.id);
    expect((await shopCall(`/jobs/${cancelJob.id}/counter-payment-returned`)).status).toBe(200);
    const closed = await fresh(cancelJob.id);
    expect(closed.status).toBe('cancelled');
    expect(closed.paymentStatus).toBe('refunded');
    expect(await commissions(cancelJob.id)).toBe(0);
  });

  it('staff confirmation racing the lease sweep: exactly one wins, commission at most once', async () => {
    const a = await makeAgent({ alive: false });
    const job = await printingJob(a.agent.id);
    const [confirm] = await Promise.all([shopCall(`/jobs/${job.id}/confirm-print-completion`), failOrphanedPrints()]);
    const final = await fresh(job.id);
    if (confirm.status === 200) {
      expect(final.status).toBe('ready_for_pickup');
      expect(await commissions(job.id)).toBe(1);
    } else {
      expect(final.status).toBe('otp_verified');
      expect(await commissions(job.id)).toBe(0);
    }
    const events = await prisma.jobEvent.findMany({ where: { jobId: job.id } });
    expect(events.filter((e) => e.fromStatus === 'printing')).toHaveLength(1);
  });

  it('D4: owner Insights buckets "today" and the last 7 days by IST, not UTC', async () => {
    const done = async (completedAt: string) => {
      const j = await printingJob(null);
      await prisma.job.updateMany({ where: { id: j.id }, data: { status: 'completed', updatedAt: new Date(completedAt) } });
    };
    // two completions: 23:50 IST on the 10th (18:20Z) and 00:10 IST on the 11th (18:40Z)
    await done('2026-10-10T18:20:00Z');
    await done('2026-10-10T18:40:00Z');
    try {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-10T18:45:00Z') }); // 00:15 IST, 11 Oct
      const at1 = (await (await shopCall('/stats', 'GET')).json()) as { stats: { todayJobs: number; last7Days: { day: string }[] } };
      expect(at1.stats.todayJobs).toBe(1); // only the 00:10 IST one is "today"
      expect(at1.stats.last7Days.at(-1)!.day).toBe('2026-10-11');
      vi.setSystemTime(new Date('2026-10-10T18:25:00Z')); // 23:55 IST, 10 Oct
      const at2 = (await (await shopCall('/stats', 'GET')).json()) as { stats: { todayJobs: number; last7Days: { day: string }[] } };
      expect(at2.stats.last7Days.at(-1)!.day).toBe('2026-10-10');
    } finally {
      vi.useRealTimers();
    }
  });

  it('D8/UI13b: confirm publishes the student socket update before slow side effects; handover emits completed', async () => {
    const a = await makeAgent({ alive: true });
    const job = await printingJob(a.agent.id);
    vi.mocked(publishEvent).mockClear();
    vi.mocked(notifyStudent).mockClear();
    expect((await shopCall(`/jobs/${job.id}/confirm-print-completion`)).status).toBe(200);
    await drainBackground();
    const studentUpdate = vi.mocked(publishEvent).mock.calls.findIndex(
      (c) => c[0] === `student:${studentId}` && c[1] === 'job:update' && (c[2] as { status: string }).status === 'ready_for_pickup',
    );
    expect(studentUpdate).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(publishEvent).mock.invocationCallOrder[studentUpdate]!)
      .toBeLessThan(vi.mocked(notifyStudent).mock.invocationCallOrder[0]!);

    vi.mocked(publishEvent).mockClear();
    expect((await shopCall(`/jobs/${job.id}/handover`)).status).toBe(200);
    expect(publishEvent).toHaveBeenCalledWith(`student:${studentId}`, 'job:update', { jobId: job.id, status: 'completed' });
  });

  it('D8: a staff member (not owner) gets 403 - not 401 - on owner-only endpoints', async () => {
    const staff = await prisma.shopUser.create({
      data: { shopId, email: `${randomUUID()}@staff.test`, passwordHash: 'x', name: 'Staff', role: 'staff' },
    });
    const staffToken = signShopToken(staff.id, shopId, 'staff', staff.sessionVersion);
    const res = await fetch(`${base}/api/shop/stats`, { headers: { authorization: `Bearer ${staffToken}` } });
    expect(res.status).toBe(403);
    const anon = await fetch(`${base}/api/shop/stats`);
    expect(anon.status).toBe(401);
  });

  describe('agent process restart (same agent id, new sessionId)', () => {
    const sid = () => `s-${randomUUID()}`;
    const heartbeat = (token: string, session: string | undefined, body: unknown = {}) =>
      agentCall(token, '/heartbeat', 'POST', body, session);

    it('claim records the claiming session', async () => {
      const s1 = sid();
      const a = await makeAgent({ alive: true, sessionId: s1 });
      const job = await printingJob(null, { ageMs: 1_000 });
      await prisma.job.update({ where: { id: job.id }, data: { status: 'otp_verified', spoolAcceptedAt: null } });
      expect((await agentCall(a.token, `/jobs/${job.id}/claim`, 'POST', {}, s1)).status).toBe(200);
      const claimed = await fresh(job.id);
      expect(claimed.status).toBe('printing');
      expect(claimed.claimedBySessionId).toBe(s1);
    });

    it('restart with the SAME agent id: heartbeat from the new process fails the orphaned print immediately; old process is refused; retry prints once', async () => {
      const s1 = sid();
      const s2 = sid();
      const a = await makeAgent({ alive: true, sessionId: s1 });
      const job = await printingJob(a.agent.id, { ageMs: 5_000, sessionId: s1 });
      vi.mocked(notifyStudent).mockClear();

      // new process (s2) comes up with the same token and heartbeats: the job it never claimed is recovered
      expect((await heartbeat(a.token, s2, { inFlightJobIds: [] })).status).toBe(200);
      const failed = await fresh(job.id);
      expect(failed.status).toBe('otp_verified');
      expect(failed.printError).toBe('agent_restarted');
      expect(failed.claimedByAgentId).toBeNull();
      expect(failed.claimedBySessionId).toBeNull();
      expect((await prisma.agent.findUniqueOrThrow({ where: { id: a.agent.id } })).sessionId).toBe(s2);
      const events = await prisma.jobEvent.findMany({ where: { jobId: job.id } });
      expect(events.some((e) => e.event === 'print_agent_restarted' && e.toStatus === 'otp_verified')).toBe(true);
      expect(notifyStudent).toHaveBeenCalledTimes(1);

      // a late report from the OLD process (or anything that still holds s1) is refused
      expect((await agentCall(a.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' }, s1)).status).toBe(409);
      expect((await agentCall(a.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' }, s2)).status).toBe(409);
      // never auto re-printed: it waits for staff
      const pending = await agentCall(a.token, '/jobs/pending', 'GET', {}, s2);
      expect(((await pending.json()) as { jobs: { id: string }[] }).jobs.some((j) => j.id === job.id)).toBe(false);
      expect((await agentCall(a.token, `/jobs/${job.id}/claim`, 'POST', {}, s2)).status).toBe(409);

      // staff retry (now allowed even though the agent id is online), new process prints it once
      expect((await shopCall(`/jobs/${job.id}/retry-print`)).status).toBe(200);
      expect((await agentCall(a.token, `/jobs/${job.id}/claim`, 'POST', {}, s2)).status).toBe(200);
      expect((await agentCall(a.token, `/jobs/${job.id}/complete`, 'POST', { outcome: 'spool_accepted' }, s2)).status).toBe(200);
      expect((await shopCall(`/jobs/${job.id}/confirm-print-completion`)).status).toBe(200);
      expect(await commissions(job.id)).toBe(1);
      expect((await fresh(job.id)).printAttempts).toBe(2);
    });

    it('the sweep recovers a restart even when no heartbeat has run yet, and staff can act before the sweep', async () => {
      const s1 = sid();
      const a = await makeAgent({ alive: true, sessionId: sid() }); // already the NEW process
      const job = await printingJob(a.agent.id, { ageMs: 5_000, sessionId: s1 });
      // staff are not told "still printing on a connected computer"
      expect((await shopCall(`/jobs/${job.id}/counter-payment-returned`)).status).toBe(200);
      expect((await fresh(job.id)).status).toBe('cancelled');
      const job2 = await printingJob(a.agent.id, { ageMs: 5_000, sessionId: s1 });
      expect(await failOrphanedPrints()).toBeGreaterThanOrEqual(1);
      expect((await fresh(job2.id)).printError).toBe('agent_restarted');
    });

    it('in-flight list: a claimed job the process is not working on is failed; reported or just-claimed jobs are kept', async () => {
      const s1 = sid();
      const a = await makeAgent({ alive: true, sessionId: s1 });
      const lost = await printingJob(a.agent.id, { ageMs: 60_000, sessionId: s1 });
      const working = await printingJob(a.agent.id, { ageMs: 60_000, sessionId: s1 });
      const justClaimed = await printingJob(a.agent.id, { ageMs: 2_000, sessionId: s1 });
      await heartbeat(a.token, s1, { inFlightJobIds: [working.id] });
      expect((await fresh(lost.id)).printError).toBe('agent_restarted');
      expect((await fresh(working.id)).status).toBe('printing');
      expect((await fresh(justClaimed.id)).status).toBe('printing'); // inside the claim/heartbeat race grace
      // an agent that does not report a list (older) is never failed by it
      const legacyView = await printingJob(a.agent.id, { ageMs: 60_000, sessionId: s1 });
      await heartbeat(a.token, s1);
      expect((await fresh(legacyView.id)).status).toBe('printing');
    });

    it('spooler-accepted prints are NOT failed by a restart (staff still confirm the paper)', async () => {
      const s1 = sid();
      const s2 = sid();
      const a = await makeAgent({ alive: true, sessionId: s1 });
      const job = await printingJob(a.agent.id, { ageMs: 60_000, sessionId: s1, spooled: true });
      await heartbeat(a.token, s2, { inFlightJobIds: [] });
      expect((await fresh(job.id)).status).toBe('printing');
      expect((await shopCall(`/jobs/${job.id}/confirm-print-completion`)).status).toBe(200);
      expect(await commissions(job.id)).toBe(1);
    });

    it('legacy agent (no session id): behaves as before, restart undetectable but the hard time limits still apply', async () => {
      const a = await makeAgent({ alive: true });
      const fresh30 = await printingJob(a.agent.id, { ageMs: 30_000 });
      expect((await heartbeat(a.token, undefined)).status).toBe(200); // no body, no header
      expect((await fresh(fresh30.id)).status).toBe('printing');
      expect((await agentCall(a.token, `/jobs/${fresh30.id}/complete`, 'POST', { outcome: 'spool_accepted' })).status).toBe(200);

      // online agent, never spooled, older than PRINT_CLAIM_TIMEOUT_SECONDS (120 s) -> failed
      const stuck = await printingJob(a.agent.id, { ageMs: 150_000 });
      await failOrphanedPrints();
      const failed = await fresh(stuck.id);
      expect(failed.status).toBe('otp_verified');
      expect(failed.printError).toBe('claim_timeout');
      expect((await shopCall('/queue', 'GET').then((r) => r.json()) as { jobs: { id: string; printErrorCode: string }[] })
        .jobs.find((j) => j.id === stuck.id)!.printErrorCode).toBe('claim_timeout');
    });

    it('spooled but never confirmed: failed after PRINT_SPOOL_TIMEOUT_SECONDS with a check-the-printer message; sooner it is left alone', async () => {
      const a = await makeAgent({ alive: true });
      const waiting = await printingJob(a.agent.id, { ageMs: 300_000, spooled: true });
      const abandoned = await printingJob(a.agent.id, { ageMs: 1_000_000, spooled: true });
      await failOrphanedPrints();
      expect((await fresh(waiting.id)).status).toBe('printing');
      const failed = await fresh(abandoned.id);
      expect(failed.status).toBe('otp_verified');
      expect(failed.printError).toBe('spool_timeout');
      const queue = (await (await shopCall('/queue', 'GET')).json()) as { jobs: { id: string; printError: string }[] };
      expect(queue.jobs.find((j) => j.id === abandoned.id)!.printError).toMatch(/check the printer|Check the printer/);
      expect((await shopCall(`/jobs/${abandoned.id}/counter-payment-returned`)).status).toBe(200);
    });

    it('concurrent staff confirmations + restart recovery: exactly one transition, exactly one commission', async () => {
      const s1 = sid();
      const a = await makeAgent({ alive: true, sessionId: s1 });
      const job = await printingJob(a.agent.id, { ageMs: 60_000, sessionId: s1, spooled: true });
      const results = await Promise.all([
        shopCall(`/jobs/${job.id}/confirm-print-completion`),
        shopCall(`/jobs/${job.id}/confirm-print-completion`),
        shopCall(`/jobs/${job.id}/confirm-print-completion`),
        heartbeat(a.token, sid(), { inFlightJobIds: [] }),
      ]);
      expect(results.slice(0, 3).filter((r) => r.status === 200)).toHaveLength(1);
      expect((await fresh(job.id)).status).toBe('ready_for_pickup');
      expect(await commissions(job.id)).toBe(1);
      const events = await prisma.jobEvent.findMany({ where: { jobId: job.id } });
      expect(events.filter((e) => e.fromStatus === 'printing')).toHaveLength(1);
    });
  });

  it('student and staff responses never carry raw agent error text', async () => {
    const a = await makeAgent({ alive: true });
    const job = await printingJob(a.agent.id);
    expect((await agentCall(a.token, `/jobs/${job.id}/fail`, 'POST', { reason: 'spooler C:\\Users\\x\\secret.pdf exit 0x80' })).status).toBe(200);
    const queue = await (await shopCall('/queue', 'GET')).text();
    expect(queue).not.toContain('secret.pdf');
    expect(queue).not.toContain('0x80');
    const sent = JSON.stringify(vi.mocked(publishEvent).mock.calls);
    expect(sent).not.toContain('secret.pdf');
  });
});
