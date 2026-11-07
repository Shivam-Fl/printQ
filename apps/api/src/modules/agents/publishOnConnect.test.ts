import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const agentUpdate = vi.hoisted(() => vi.fn());
const printerFindMany = vi.hoisted(() => vi.fn());
const publishIfReady = vi.hoisted(() => vi.fn());
vi.mock('../../lib/prisma.js', () => ({
  prisma: { agent: { update: agentUpdate }, printer: { findMany: printerFindMany }, $disconnect: vi.fn() },
}));
vi.mock('../shops/autoLive.js', () => ({ publishIfReady }));
vi.mock('../../middleware/auth.js', () => ({
  requireAgent: (req: { agent?: unknown }, _res: unknown, next: () => void) => {
    req.agent = { id: 'a1', shopId: 's1', sessionId: null, connectedPrinterIds: [] };
    next();
  },
}));
vi.mock('../queue/engine.js', () => ({ advanceShopQueues: vi.fn(), emitQueueUpdate: vi.fn() }));
vi.mock('../shops/availability.js', () => ({ notifyShopReopened: vi.fn() }));
vi.mock('../../realtime/events.js', () => ({ publishEvent: vi.fn() }));
vi.mock('../../providers/storage/index.js', () => ({ storage: {} }));
vi.mock('../jobs/transitions.js', () => ({ applyTransition: vi.fn() }));
vi.mock('../jobs/printCompletion.js', () => ({ confirmSuccessfulPrint: vi.fn(), recordSpoolAccepted: vi.fn() }));
vi.mock('../jobs/printLease.js', () => ({ reconcileAgentSession: vi.fn() }));
vi.mock('../../lib/preparePrintPdf.js', () => ({ preparePrintPdf: vi.fn() }));
vi.mock('../../lib/printProblem.js', () => ({ STAFF_DECISION_PRINT_ERRORS: [], describePrintProblem: vi.fn() }));

import { agentRouter } from './routes.js';

describe('agent routes publish a ready auto-live shop', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/agent', agentRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    agentUpdate.mockReset().mockResolvedValue({});
    printerFindMany.mockReset().mockResolvedValue([]);
    publishIfReady.mockReset().mockResolvedValue(true);
  });

  const post = (path: string, body: unknown) =>
    fetch(`${base}/agent${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('tries to publish when an agent heartbeat marks it online', async () => {
    expect((await post('/heartbeat', {})).status).toBe(200);
    expect(publishIfReady).toHaveBeenCalledWith('s1');
  });

  it('tries to publish when an agent reports its printers', async () => {
    expect((await post('/printers', { printers: [{ name: 'HP' }] })).status).toBe(200);
    expect(publishIfReady).toHaveBeenCalledWith('s1');
  });

  it('never fails the agent call when publishing throws', async () => {
    publishIfReady.mockRejectedValue(new Error('db down'));
    expect((await post('/heartbeat', {})).status).toBe(200);
  });
});
