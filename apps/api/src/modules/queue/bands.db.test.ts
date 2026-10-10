/**
 * Database-backed behaviour tests for queue bands, reveal grace and absent
 * handling. They need the migrated PostgreSQL that CI (and `docker compose`)
 * provides; without it the suite is skipped so `npm test` stays usable on a
 * machine with no infrastructure. Every row is scoped to throw-away shops and
 * deleted afterwards. Push/socket/BullMQ side effects are captured, not sent.
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => ({
  notes: [] as { studentId: string; title: string; body: string; eventKey?: string }[],
  events: [] as { room: string; event: string; payload: unknown }[],
}));

vi.mock('../../providers/notification/index.js', () => ({
  notifyStudent: vi.fn(async (studentId: string, message: { title: string; body: string; eventKey?: string }) => {
    sent.notes.push({ studentId, ...message });
  }),
}));
vi.mock('../../realtime/events.js', () => ({
  publishEvent: vi.fn((room: string, event: string, payload: unknown) => {
    sent.events.push({ room, event, payload });
  }),
  subscribeEvents: vi.fn(),
}));

import { prisma } from '../../lib/prisma.js';
import { timersQueue } from '../../lib/queues.js';
import { decryptReleaseCode } from '../../lib/otp.js';
import { signShopToken, signStudentToken } from '../../lib/tokens.js';
import { errorHandler } from '../../middleware/error.js';
import { jobsRouter } from '../jobs/routes.js';
import { shopRouter } from '../shops/routes.js';
import {
  checkInJob,
  emitQueueUpdate,
  expireReveal,
  getJobLiveMetrics,
  preparePayAtShopOrder,
  requeueJob,
  sweepExpiredReveals,
} from './engine.js';
import { releaseByOtp } from './release.js';
import { drainBackground } from '../../lib/background.js';

/** Check-in sends its notifications after responding; wait for them before asserting. */
async function checkInAndSettle(...args: Parameters<typeof checkInJob>) {
  try {
    return await checkInJob(...args);
  } finally {
    await drainBackground();
  }
}

const LAT = 28.6139;
const LNG = 77.209;
const M_PER_DEG_LAT = 111_194.93;

const dbReady = await (async () => {
  try {
    await prisma.shop.findFirst({ select: { counterCapacity: true, revealGraceSeconds: true } });
    await prisma.job.findFirst({ select: { revealedAt: true, revealDeadlineAt: true, arrivingNotifiedAt: true } });
    return true;
  } catch (error) {
    console.warn('bands.db.test skipped: database not ready —', String(error).slice(0, 300));
    return false;
  }
})();

// Each check-in is several round trips; remote CI databases can be slow.
vi.setConfig({ testTimeout: 60_000 });

const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.runIf(dbReady)('queue bands, grace and absent (database)', () => {
  let shopId = '';
  let otherShopId = '';
  let ownerId = '';
  let ownerToken = '';
  let staffToken = '';
  let otherOwnerToken = '';
  let printerId = '';
  let server: Server;
  let base = '';
  const studentIds: string[] = [];
  const shopIds: string[] = [];
  const timerAdd = vi.spyOn(timersQueue, 'add').mockResolvedValue(undefined as never);

  const api = (path: string, token: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  async function makeShop(tag: string): Promise<string> {
    const shop = await prisma.shop.create({
      data: {
        slug: `qb-${tag}-${randomUUID().slice(0, 8)}`,
        name: `Queue band ${tag}`,
        address: 'Test lane',
        latitude: LAT,
        longitude: LNG,
        rateCard: {},
      },
    });
    shopIds.push(shop.id);
    return shop.id;
  }

  async function makeStudent() {
    const student = await prisma.student.create({
      data: { phone: `+91${Math.floor(1_000_000_000 + Math.random() * 8_999_999_999)}`, name: 'Band Tester' },
    });
    studentIds.push(student.id);
    return student;
  }

  /** A prepared (awaiting_arrival) pay-at-shop order with a stable counter code. */
  async function prepared(forShop = shopId) {
    const student = await makeStudent();
    const file = await prisma.uploadedFile.create({
      data: {
        studentId: student.id, shopId: forShop, originalName: 'a.pdf', originalKey: `k-${randomUUID()}`,
        mimeType: 'application/pdf', sizeBytes: 1, pages: 1, status: 'ready',
      },
    });
    const job = await prisma.job.create({
      data: {
        shopId: forShop, studentId: student.id, fileId: file.id, specs, pagesPerCopy: 1,
        priceBreakdown: {}, totalPaise: 500, paymentProvider: 'pay_at_shop',
      },
    });
    await preparePayAtShopOrder(job.id);
    return { jobId: job.id, studentId: student.id, token: signStudentToken(student.id) };
  }

  const arrival = (offsetM = 0) => ({
    latitude: LAT + offsetM / M_PER_DEG_LAT, longitude: LNG, accuracyM: 10, measuredAt: new Date(),
  });

  async function joined(forShop = shopId) {
    const order = await prepared(forShop);
    await sleep(3);
    await checkInAndSettle(order.jobId, order.studentId, arrival());
    return order;
  }

  const row = (jobId: string) => prisma.job.findUniqueOrThrow({ where: { id: jobId } });
  const code = async (jobId: string) => {
    const job = await row(jobId);
    return decryptReleaseCode(job.shopId, job.releaseCodeEncrypted)!;
  };
  const setSettings = (data: { counterCapacity?: number; revealGraceSeconds?: number }) =>
    api('/api/shop/me', ownerToken, { method: 'PATCH', body: data });
  const notesFor = (studentId: string, titlePart: string) =>
    sent.notes.filter((n) => n.studentId === studentId && n.title.includes(titlePart));
  const releaseFor = (jobId: string, otp: string) =>
    releaseByOtp(shopId, otp, ownerId, undefined, false, { method: 'cash' });

  beforeAll(async () => {
    shopId = await makeShop('a');
    otherShopId = await makeShop('b');
    // Shop tokens are checked against real accounts (revocation), so create them.
    const account = async (forShop: string, role: 'owner' | 'staff') => {
      const user = await prisma.shopUser.create({
        data: { shopId: forShop, email: `qb-${randomUUID()}@example.test`, name: role, role, passwordHash: 'x' },
      });
      return user;
    };
    const owner = await account(shopId, 'owner');
    const staff = await account(shopId, 'staff');
    const otherOwner = await account(otherShopId, 'owner');
    ownerId = owner.id;
    ownerToken = signShopToken(owner.id, shopId, 'owner');
    staffToken = signShopToken(staff.id, shopId, 'staff');
    otherOwnerToken = signShopToken(otherOwner.id, otherShopId, 'owner');
    const printer = await prisma.printer.create({
      data: { shopId, label: 'P1', paperSizesLoaded: ['A4'], colorSupport: false, status: 'online' },
    });
    printerId = printer.id;
    await prisma.agent.create({
      data: {
        shopId, machineLabel: 'PC', tokenHash: randomUUID(), status: 'online',
        connectedPrinterIds: [printerId], lastHeartbeatAt: new Date(),
      },
    });
    const app = express();
    app.use(express.json());
    app.use('/api/jobs', jobsRouter);
    app.use('/api/shop', shopRouter);
    app.use(errorHandler);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  beforeEach(async () => {
    sent.notes.length = 0;
    sent.events.length = 0;
    timerAdd.mockClear();
    // Each test starts from an empty live line at the defaults.
    const stale = await prisma.job.findMany({ where: { shopId }, select: { id: true } });
    const staleIds = stale.map((j) => j.id);
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: staleIds } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: staleIds } } });
    await prisma.paymentEvent.deleteMany({ where: { jobId: { in: staleIds } } });
    await prisma.job.deleteMany({ where: { id: { in: staleIds } } });
    await prisma.shop.update({ where: { id: shopId }, data: { counterCapacity: 2, revealGraceSeconds: 60 } });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const jobs = await prisma.job.findMany({ where: { shopId: { in: shopIds } }, select: { id: true } });
    const jobIds = jobs.map((j) => j.id);
    await prisma.realtimeOutbox.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.jobEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.paymentEvent.deleteMany({ where: { jobId: { in: jobIds } } });
    await prisma.job.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.uploadedFile.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.agent.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.printer.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.shopUser.deleteMany({ where: { shopId: { in: shopIds } } });
    await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  });

  it('new shops default to a 200 m zone, capacity 5 and a 60 s grace', async () => {
    const fresh = await prisma.shop.create({
      data: { slug: `qb-d-${randomUUID().slice(0, 8)}`, name: 'Defaults', address: 'x', rateCard: {} },
    });
    shopIds.push(fresh.id);
    expect([fresh.checkInRadiusM, fresh.counterCapacity, fresh.revealGraceSeconds]).toEqual([200, 5, 60]);
  });

  describe('check-in radius (200 m)', () => {
    it('accepts 199.5 m and rejects 200.5 m', async () => {
      const near = await prepared();
      await expect(checkInAndSettle(near.jobId, near.studentId, arrival(199.5))).resolves.toMatchObject({ status: 'queued' });
      const far = await prepared();
      await expect(checkInAndSettle(far.jobId, far.studentId, arrival(200.5))).rejects.toMatchObject({ status: 409 });
      expect((await row(far.jobId)).status).toBe('awaiting_arrival');
    });
  });

  describe('reveal at check-in', () => {
    it('reveals immediately when a slot is free: code, deadline, timer and one notification', async () => {
      const first = await joined();
      const job = await row(first.jobId);
      expect(job.revealedAt).not.toBeNull();
      expect(job.revealDeadlineAt!.getTime() - job.revealedAt!.getTime()).toBe(60_000);
      expect(notesFor(first.studentId, 'your turn')).toHaveLength(1);
      expect(notesFor(first.studentId, 'your turn')[0]!.body).toMatch(/counter/i);
      const timer = timerAdd.mock.calls.find((c) => c[2]?.jobId?.includes(first.jobId))!;
      expect(timer[0]).toBe('revealExpiry');
      expect(timer[2]!.jobId).toBe(`absent-${first.jobId}-${job.revealedAt!.getTime()}`);
      expect(timer[2]!.jobId).not.toContain(':');
      // repeated queue refreshes never re-notify or re-arm
      await emitQueueUpdate(shopId);
      await emitQueueUpdate(shopId);
      expect(notesFor(first.studentId, 'your turn')).toHaveLength(1);
      expect((await row(first.jobId)).revealDeadlineAt).toEqual(job.revealDeadlineAt);
    });

    it('splits a line into revealed / arriving / waiting and notifies arriving exactly once', async () => {
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 5; i += 1) line.push(await joined());
      const bands = await Promise.all(line.map((l) => getJobLiveMetrics(l.jobId)));
      expect(bands.map((b) => b.band)).toEqual(['revealed', 'revealed', 'arriving', 'arriving', 'waiting']);
      expect(bands.map((b) => b.position)).toEqual([1, 2, 3, 4, 5]);
      await emitQueueUpdate(shopId);
      await emitQueueUpdate(shopId);
      expect(notesFor(line[2]!.studentId, 'coming up')).toHaveLength(1);
      expect(notesFor(line[3]!.studentId, 'coming up')[0]!.body).toMatch(/head to the shop/i);
      expect(notesFor(line[4]!.studentId, 'coming up')).toHaveLength(0);
      expect(notesFor(line[4]!.studentId, 'your turn')).toHaveLength(0);
      // only the revealed jobs ever get a deadline
      expect((await row(line[2]!.jobId)).revealDeadlineAt).toBeNull();
      expect((await row(line[1]!.jobId)).revealDeadlineAt).not.toBeNull();
    });
  });

  describe('shifting bands', () => {
    it('completion of a revealed job reveals the next student and promotes the rest', async () => {
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 5; i += 1) line.push(await joined());
      sent.notes.length = 0;
      const out = await releaseFor(line[0]!.jobId, await code(line[0]!.jobId));
      expect(out.ok).toBe(true);
      expect((await getJobLiveMetrics(line[2]!.jobId)).band).toBe('revealed');
      expect(notesFor(line[2]!.studentId, 'your turn')).toHaveLength(1);
      expect((await row(line[2]!.jobId)).revealDeadlineAt).not.toBeNull();
      // line[3] stays arriving (already notified, no repeat); line[4] newly arriving
      expect(notesFor(line[3]!.studentId, 'coming up')).toHaveLength(0);
      expect((await getJobLiveMetrics(line[4]!.jobId)).band).toBe('arriving');
      expect(notesFor(line[4]!.studentId, 'coming up')).toHaveLength(1);
    });

    it('a student cancelling shifts the line the same way', async () => {
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 3; i += 1) line.push(await joined());
      const res = await api(`/api/jobs/${line[1]!.jobId}/cancel`, line[1]!.token, { method: 'POST' });
      expect(res.status).toBe(200);
      expect((await getJobLiveMetrics(line[2]!.jobId)).band).toBe('revealed');
      expect(notesFor(line[2]!.studentId, 'your turn')).toHaveLength(1);
    });
  });

  describe('staff mark absent', () => {
    it('removes the place, keeps the paid order + code, notifies, and reveals the next student', async () => {
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 3; i += 1) line.push(await joined());
      const before = await code(line[0]!.jobId);
      sent.notes.length = 0;
      const res = await api(`/api/shop/jobs/${line[0]!.jobId}/no-show`, staffToken, { method: 'POST' });
      expect(res.status).toBe(200);
      const job = await row(line[0]!.jobId);
      expect(job).toMatchObject({
        status: 'awaiting_arrival', queuedAt: null, revealedAt: null, revealDeadlineAt: null,
        absentReason: 'staff', paymentStatus: 'counter_due',
      });
      expect(job.absentAt).not.toBeNull();
      expect(await code(line[0]!.jobId)).toBe(before); // stable code
      expect(notesFor(line[0]!.studentId, 'missed your turn')).toHaveLength(1);
      expect(notesFor(line[0]!.studentId, 'missed your turn')[0]!.body).toMatch(/check in again/i);
      expect(notesFor(line[2]!.studentId, 'your turn')).toHaveLength(1);
      const audit = await prisma.jobEvent.findFirstOrThrow({ where: { jobId: line[0]!.jobId, event: 'ABSENT_STAFF' } });
      expect(audit.actorType).toBe('shop');
      // student view: no code, absent, can check in again
      const view = await (await api(`/api/jobs/${line[0]!.jobId}`, line[0]!.token)).json() as { job: Record<string, unknown> };
      expect(view.job).toMatchObject({ absent: true, canCheckIn: true, otpCode: null, band: null });
    });

    it('returns 404 for a job that is missing or belongs to another shop', async () => {
      const mine = await joined();
      const foreign = await api(`/api/shop/jobs/${mine.jobId}/no-show`, otherOwnerToken, { method: 'POST' });
      expect(foreign.status).toBe(404);
      expect((await row(mine.jobId)).status).toBe('queued');
      const missing = await api(`/api/shop/jobs/${randomUUID()}/no-show`, ownerToken, { method: 'POST' });
      expect(missing.status).toBe(404);
    });

    it('rejoining needs a fresh check-in and lands at the back; location-free requeue stays rejected', async () => {
      const a = await joined();
      const b = await joined();
      const c = await joined();
      await api(`/api/shop/jobs/${a.jobId}/no-show`, ownerToken, { method: 'POST' });
      await expect(requeueJob(a.jobId, a.studentId)).rejects.toMatchObject({ status: 409 });
      expect((await row(a.jobId)).status).toBe('awaiting_arrival');
      await sleep(3);
      await checkInAndSettle(a.jobId, a.studentId, arrival());
      const metrics = await Promise.all([b, c, a].map((j) => getJobLiveMetrics(j.jobId)));
      expect(metrics.map((m) => m.position)).toEqual([1, 2, 3]);
      expect(metrics[2]!.band).toBe('arriving'); // behind two revealed students
      const job = await row(a.jobId);
      expect(job).toMatchObject({ revealedAt: null, absentAt: null, absentReason: null });
    });
  });

  describe('grace expiry (automatic absent)', () => {
    it('expires only overdue reveals, through the same absent path, exactly once', async () => {
      const a = await joined();
      const b = await joined();
      const c = await joined();
      await prisma.job.update({ where: { id: a.jobId }, data: { revealDeadlineAt: new Date(Date.now() - 1_000) } });
      sent.notes.length = 0;
      expect(await sweepExpiredReveals()).toBe(1);
      expect(await sweepExpiredReveals()).toBe(0); // idempotent
      expect(await expireReveal(a.jobId)).toBe(false);
      const job = await row(a.jobId);
      expect(job).toMatchObject({ status: 'awaiting_arrival', absentReason: 'grace_expired', revealedAt: null });
      expect((await row(b.jobId)).status).toBe('queued'); // not overdue, untouched
      expect(notesFor(a.studentId, 'missed your turn')).toHaveLength(1);
      expect(notesFor(c.studentId, 'your turn')).toHaveLength(1); // next student revealed
      const audit = await prisma.jobEvent.findFirstOrThrow({ where: { jobId: a.jobId, event: 'ABSENT_TIMEOUT' } });
      expect(audit.actorType).toBe('system');
    });

    it('is disarmed once staff looked the job up by its counter code', async () => {
      const a = await joined();
      await prisma.job.update({ where: { id: a.jobId }, data: { revealDeadlineAt: new Date(Date.now() - 1_000) } });
      // Lookup without payment confirmation only returns the payment prompt,
      // but proves the student is at the counter, so the timer must stop.
      sent.events.length = 0;
      const prompt = await releaseByOtp(shopId, await code(a.jobId), ownerId);
      expect(prompt.requiresPaymentConfirmation).toBe(true);
      // The dashboard and the student must stop showing the stale countdown.
      const pushed = sent.events.filter((e) => e.room === `shop:${shopId}` && e.event === 'queue:update');
      expect(pushed.length).toBeGreaterThan(0);
      const last = pushed[pushed.length - 1].payload as { jobs: { jobId: string; revealDeadlineAt: string | null }[] };
      expect(last.jobs.find((j) => j.jobId === a.jobId)?.revealDeadlineAt).toBeNull();
      expect(await expireReveal(a.jobId)).toBe(false);
      expect(await sweepExpiredReveals()).toBe(0);
      expect((await row(a.jobId)).status).toBe('queued');
    });

    it('a release racing the expiry leaves exactly one consistent outcome', async () => {
      for (let i = 0; i < 4; i += 1) {
        const a = await joined();
        const otp = await code(a.jobId);
        await prisma.job.update({ where: { id: a.jobId }, data: { revealDeadlineAt: new Date(Date.now() - 1_000) } });
        await Promise.allSettled([expireReveal(a.jobId), releaseFor(a.jobId, otp)]);
        const job = await row(a.jobId);
        if (job.status === 'otp_verified') {
          expect(job.absentAt).toBeNull();
        } else {
          expect(job.status).toBe('awaiting_arrival');
          expect(job.absentReason).toBe('grace_expired');
          expect(job.counterPaymentConfirmedAt).toBeNull();
        }
        await prisma.job.update({ where: { id: a.jobId }, data: { status: 'cancelled' } });
        await emitQueueUpdate(shopId);
      }
    });
  });

  describe('owner settings while a queue exists', () => {
    it('lowering capacity never un-reveals; raising it reveals extra students now; grace only affects future reveals', async () => {
      await setSettings({ counterCapacity: 3 });
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 5; i += 1) line.push(await joined());
      const revealedBefore = await Promise.all(line.slice(0, 3).map((l) => row(l.jobId)));
      expect(revealedBefore.every((j) => j.revealedAt !== null)).toBe(true);

      expect((await setSettings({ counterCapacity: 1 })).status).toBe(200);
      for (const l of line.slice(0, 3)) expect((await getJobLiveMetrics(l.jobId)).band).toBe('revealed');
      expect((await row(line[0]!.jobId)).revealedAt).toEqual(revealedBefore[0]!.revealedAt);
      expect((await row(line[3]!.jobId)).revealedAt).toBeNull();

      // one revealed job leaves: three remain >= capacity 1, so nobody new yet
      await api(`/api/shop/jobs/${line[0]!.jobId}/no-show`, ownerToken, { method: 'POST' });
      expect((await row(line[3]!.jobId)).revealedAt).toBeNull();

      await setSettings({ revealGraceSeconds: 120 });
      expect((await row(line[1]!.jobId)).revealDeadlineAt).toEqual(revealedBefore[1]!.revealDeadlineAt);

      sent.notes.length = 0;
      expect((await setSettings({ counterCapacity: 5 })).status).toBe(200);
      for (const l of line.slice(3)) {
        const job = await row(l.jobId);
        expect(job.revealedAt).not.toBeNull();
        expect(job.revealDeadlineAt!.getTime() - job.revealedAt!.getTime()).toBe(120_000);
        expect(notesFor(l.studentId, 'your turn')).toHaveLength(1);
      }
    });

    it('validates settings server-side and is owner-only', async () => {
      for (const bad of [{ counterCapacity: 0 }, { counterCapacity: 21 }, { counterCapacity: 2.5 }, { revealGraceSeconds: 45 }, { checkInRadiusM: 150 }]) {
        expect((await setSettings(bad)).status).toBe(400);
      }
      for (const good of [{ counterCapacity: 1 }, { counterCapacity: 20 }, { revealGraceSeconds: 30 }, { revealGraceSeconds: 120 }, { checkInRadiusM: 200 }]) {
        expect((await setSettings(good)).status).toBe(200);
      }
      expect((await api('/api/shop/me', staffToken, { method: 'PATCH', body: { counterCapacity: 3 } })).status).toBe(401);
      const me = await (await api('/api/shop/me', ownerToken)).json() as { shop: Record<string, unknown> };
      expect(me.shop).toMatchObject({ counterCapacity: 20, revealGraceSeconds: 120, checkInRadiusM: 200 });
      // settings never leak across shops
      expect((await prisma.shop.findUniqueOrThrow({ where: { id: otherShopId } })).counterCapacity).toBe(5);
    });
  });

  describe('counter code never leaks outside the revealed band', () => {
    it('student job API, shop queue API, socket payloads and notifications', async () => {
      const line = [] as Awaited<ReturnType<typeof joined>>[];
      for (let i = 0; i < 5; i += 1) line.push(await joined());
      const codes = await Promise.all(line.map((l) => code(l.jobId)));
      const views = await Promise.all(line.map(async (l) => (await (await api(`/api/jobs/${l.jobId}`, l.token)).json() as { job: Record<string, unknown> }).job));
      expect(views.map((v) => v.band)).toEqual(['revealed', 'revealed', 'arriving', 'arriving', 'waiting']);
      expect(views[0]!.otpCode).toBe(codes[0]);
      expect(views[1]!.otpCode).toBe(codes[1]);
      expect(views[0]!.revealDeadlineAt).toBeTruthy();
      for (const v of views.slice(2)) {
        expect(v.otpCode).toBeNull();
        expect(v.counterCodeAvailable).toBe(false);
        expect(v.revealDeadlineAt).toBeNull();
      }
      const queue = await (await api('/api/shop/queue', ownerToken)).json() as { counterCapacity: number; jobs: Record<string, unknown>[] };
      expect(queue.counterCapacity).toBe(2);
      expect(queue.jobs.map((j) => j.band)).toEqual(['revealed', 'revealed', 'arriving', 'arriving', 'waiting']);
      await emitQueueUpdate(shopId);
      const everything = JSON.stringify([sent.events, sent.notes, queue]);
      for (const c of codes) expect(everything).not.toContain(c);
    });

    it('another student gets 404 for the job', async () => {
      const mine = await joined();
      const other = await makeStudent();
      const res = await api(`/api/jobs/${mine.jobId}`, signStudentToken(other.id));
      expect(res.status).toBe(404);
    });
  });
});
