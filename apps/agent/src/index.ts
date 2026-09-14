#!/usr/bin/env node
/**
 * PrintQ print agent — runs on a shop PC that can reach one or more printers.
 *
 * First run: paste the agent token shown once on the dashboard's Agents page.
 * It's saved locally (~/.printq-agent/config.json) so you never enter it
 * again — just start the agent the same way each time (e.g. a desktop
 * shortcut running `npm start`).
 *
 * Printers are auto-detected from the OS — no more hand-typed printer-name
 * mapping. The agent reports every installed printer it can see; the
 * dashboard's Printers page lets the owner link a PrintQ printer profile to
 * one of them with a single click, and which PC can reach which printer is
 * derived automatically from that link.
 *
 * Configuration:
 *   PRINTQ_API_URL      e.g. https://api.printq.example (default http://localhost:4000)
 *   PRINTQ_AGENT_TOKEN  optional — skips the first-run prompt if already set
 *
 * Flow: connect socket -> report detected printers -> receive job:dispatch ->
 * claim (first agent wins) -> download converted PDF -> hand to OS spooler ->
 * report complete/fail.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { io, type Socket } from 'socket.io-client';
import { detectPrinters, isSimulationMode, sendToPrinter } from './printerRuntime.js';

const API_URL = process.env.PRINTQ_API_URL ?? 'http://localhost:4000';
const CONFIG_DIR = path.join(homedir(), '.printq-agent');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const HEARTBEAT_MS = 30_000;

interface DispatchPayload {
  jobId: string;
  printerId: string;
  specs: { copies: number; duplex: boolean; color: boolean; paperSize: string };
}

interface DriverMedia {
  paperSize: string;
  bin?: string | null;
}

/** First run: prompt once for the token and remember it; every run after, just read it. */
async function loadToken(): Promise<string> {
  if (process.env.PRINTQ_AGENT_TOKEN) return process.env.PRINTQ_AGENT_TOKEN;

  if (existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as { token?: string };
      if (saved.token) return saved.token;
    } catch {
      // corrupt config — fall through and re-prompt
    }
  }

  console.log('PrintQ agent — first-time setup on this PC.');
  console.log("Paste the token shown once on your shop dashboard's Agents page.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const token = (await rl.question('Agent token: ')).trim();
  rl.close();
  if (!token) {
    console.error('No token entered — exiting.');
    process.exit(1);
  }
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify({ token }, null, 2), { mode: 0o600 });
  console.log(`Saved — you won't need to enter this again on this PC (${CONFIG_FILE}).`);
  return token;
}

const TOKEN = await loadToken();

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { 'x-agent-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });
}

/** Tell the dashboard every printer this PC can see — replaces hand-typed printer-name mapping. */
async function reportPrinters(): Promise<void> {
  try {
    const detected = await detectPrinters();
    await api('/api/agent/printers', {
      method: 'POST',
      body: JSON.stringify({
        printers: detected.map((p) => ({ name: p.name, paperSizes: p.paperSizes })),
      }),
    });
    console.log(`Reported ${detected.length} printer(s) found on this PC.`);
  } catch (err) {
    console.error('Printer detection failed —', err instanceof Error ? err.message : err);
  }
}

async function printJob(job: DispatchPayload): Promise<void> {
  // claim first (server already scopes this to printers this PC is linked
  // to, via connectedPrinterIds) — the conditional update is the lock.
  const claim = await api(`/api/agent/jobs/${job.jobId}/claim`, { method: 'POST' });
  if (!claim.ok) {
    console.log(`Job ${job.jobId}: not claimed (${claim.status})`);
    return;
  }
  const { job: claimed } = (await claim.json()) as {
    job: { osPrinterName: string | null; mediaConfig: Record<string, DriverMedia> | null };
  };
  const osPrinter = claimed.osPrinterName;
  const media = claimed.mediaConfig?.[job.specs.paperSize] ?? { paperSize: job.specs.paperSize };

  if (!osPrinter) {
    console.warn(
      `Job ${job.jobId}: this PrintQ printer isn't linked to an OS printer yet — link it on the dashboard's Printers page.`,
    );
    await api(`/api/agent/jobs/${job.jobId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'printer not linked to an OS printer' }),
    }).catch(() => undefined);
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'printq-agent-'));
  try {
    const fileRes = await api(`/api/agent/jobs/${job.jobId}/file`);
    if (!fileRes.ok) throw new Error(`file download failed: ${fileRes.status}`);
    const pdfPath = path.join(dir, `${job.jobId}.pdf`);
    await writeFile(pdfPath, Buffer.from(await fileRes.arrayBuffer()));

    console.log(`Printing job ${job.jobId} on "${osPrinter}" (${job.specs.copies} copies)`);
    await sendToPrinter(pdfPath, {
      printer: osPrinter,
      copies: job.specs.copies,
      duplex: job.specs.duplex,
      color: job.specs.color,
      paperSize: media.paperSize,
      bin: media.bin ?? null,
      jobId: job.jobId,
    });

    await api(`/api/agent/jobs/${job.jobId}/complete`, { method: 'POST' });
    console.log(`Job ${job.jobId}: completed`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown';
    console.error(`Job ${job.jobId}: print failed —`, reason);
    await api(`/api/agent/jobs/${job.jobId}/fail`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }).catch(() => undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Jobs dispatched while this agent was offline. */
async function drainPending(): Promise<void> {
  try {
    const res = await api('/api/agent/jobs/pending');
    if (!res.ok) return;
    const { jobs } = (await res.json()) as {
      jobs: { id: string; assignedPrinterId: string; specs: DispatchPayload['specs'] }[];
    };
    for (const job of jobs) {
      await printJob({ jobId: job.id, printerId: job.assignedPrinterId, specs: job.specs });
    }
  } catch (err) {
    console.error('pending drain failed', err);
  }
}

function connect(): Socket {
  const socket = io(API_URL, { auth: { agentToken: TOKEN } });

  socket.on('connect', () => {
    console.log('Connected to PrintQ');
    void reportPrinters();
    void drainPending();
  });
  socket.on('job:dispatch', (payload: DispatchPayload) => {
    void printJob(payload);
  });
  socket.on('disconnect', (reason) => console.warn('Disconnected:', reason));
  socket.on('connect_error', (err) => console.error('Connection error:', err.message));
  return socket;
}

connect();
setInterval(() => {
  api('/api/agent/heartbeat', { method: 'POST' }).catch((err) =>
    console.error('heartbeat failed', err instanceof Error ? err.message : err),
  );
  void reportPrinters();
}, HEARTBEAT_MS);

console.log(`PrintQ agent starting — API: ${API_URL}${isSimulationMode() ? ' · SIMULATION MODE' : ''}`);
