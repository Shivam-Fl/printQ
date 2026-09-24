#!/usr/bin/env node
/**
 * PrintQ print agent — runs on a shop PC that can reach one or more printers.
 *
 * For a persistent Windows setup, use the PrintQs Shop desktop installer. It
 * stores the one-time token in the Windows secure store. The standalone CLI
 * intentionally keeps a manually entered token only for its current process.
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
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { io, type Socket } from 'socket.io-client';
import { detectPrinters, isSimulationMode, sendToPrinter } from './printerRuntime.js';
import { createPrinterTestPage } from './printerTestPage.js';
import { loadEphemeralAgentToken } from './cliToken.js';

const API_URL = process.env.PRINTQ_API_URL ?? 'http://localhost:4000';
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

interface PrinterTestPayload {
  testId: string;
  printerId: string;
  printerLabel: string;
  osPrinterName: string;
  options: { paperSize: string; bin: string | null; color: boolean; duplex: boolean };
}

/** A CLI-entered token never touches disk; use the desktop app for a persistent setup. */
async function loadToken(): Promise<string> {
  if (!process.env.PRINTQ_AGENT_TOKEN?.trim()) {
    console.log('PrintQ agent — first-time setup on this PC.');
    console.log('Use the PrintQs Shop desktop app for a persistent, Windows-secure setup.');
  }
  return loadEphemeralAgentToken(process.env.PRINTQ_AGENT_TOKEN, async () => {
    console.log("Paste the token shown once on your shop dashboard's Agents page.");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const token = await rl.question('Agent token: ');
    rl.close();
    return token;
  });
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

    const completion = await api(`/api/agent/jobs/${job.jobId}/complete`, {
      method: 'POST',
      body: JSON.stringify({ outcome: isSimulationMode() ? 'simulator_complete' : 'spool_accepted' }),
    });
    if (!completion.ok) throw new Error(`completion update failed: ${completion.status}`);
    const outcome = (await completion.json().catch(() => ({}))) as { completionConfirmationRequired?: boolean };
    console.log(
      outcome.completionConfirmationRequired
        ? `Job ${job.jobId}: spool accepted — staff must confirm the printed output in PrintQs.`
        : `Job ${job.jobId}: completed`,
    );
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

function isPrinterTestPayload(value: unknown): value is PrinterTestPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<PrinterTestPayload>;
  return typeof payload.testId === 'string'
    && typeof payload.printerId === 'string'
    && typeof payload.printerLabel === 'string'
    && typeof payload.osPrinterName === 'string'
    && Boolean(payload.options)
    && typeof payload.options?.paperSize === 'string'
    && typeof payload.options?.color === 'boolean'
    && typeof payload.options?.duplex === 'boolean'
    && (payload.options?.bin === null || typeof payload.options?.bin === 'string');
}

/** Print only a local setup page; this has no Job, order, or customer content. */
async function printTestPage(payload: PrinterTestPayload): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'printq-agent-test-'));
  try {
    const pdfPath = path.join(dir, 'printer-test-page.pdf');
    await writeFile(pdfPath, await createPrinterTestPage({
      printerLabel: payload.printerLabel,
      paperSize: payload.options.paperSize,
      color: payload.options.color,
      duplex: payload.options.duplex,
      bin: payload.options.bin,
    }));
    await sendToPrinter(pdfPath, {
      printer: payload.osPrinterName,
      copies: 1,
      duplex: payload.options.duplex,
      color: payload.options.color,
      paperSize: payload.options.paperSize,
      bin: payload.options.bin,
      jobId: `test-${payload.testId}`,
    });
    const result = await api('/api/agent/printer-tests/result', {
      method: 'POST',
      body: JSON.stringify({ testId: payload.testId, printerId: payload.printerId, status: 'spool_accepted' }),
    });
    if (!result.ok) throw new Error(`test result update failed: ${result.status}`);
    console.log(`Printer setup page accepted by the spooler for ${payload.printerLabel}.`);
  } catch (err) {
    const reason = err instanceof Error ? err.message.slice(0, 200) : 'unknown printer test failure';
    console.error('Printer setup page failed —', reason);
    await api('/api/agent/printer-tests/result', {
      method: 'POST',
      body: JSON.stringify({ testId: payload.testId, printerId: payload.printerId, status: 'failed', error: reason }),
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
  socket.on('printer:test_page', (payload: unknown) => {
    if (!isPrinterTestPayload(payload)) {
      console.warn('Ignored an invalid printer setup request.');
      return;
    }
    void printTestPage(payload);
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
