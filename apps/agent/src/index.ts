/**
 * PrintQ print agent — runs on a shop PC that can reach one or more printers.
 *
 * Configuration via environment (or a .env loaded by the shell):
 *   PRINTQ_API_URL      e.g. https://api.printq.example  (or http://localhost:4000)
 *   PRINTQ_AGENT_TOKEN  token shown once when the owner registers this PC
 *   PRINTER_MAP         JSON mapping PrintQ printer ids to OS printer names,
 *                       e.g. {"<printer-uuid>":"HP LaserJet 1020"}
 *
 * Flow: connect socket → receive job:dispatch → claim (first agent wins) →
 * download converted PDF → hand to OS spooler → report complete/fail.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io, type Socket } from 'socket.io-client';
import printer from 'pdf-to-printer';

const API_URL = process.env.PRINTQ_API_URL ?? 'http://localhost:4000';
const TOKEN = process.env.PRINTQ_AGENT_TOKEN ?? '';
const PRINTER_MAP: Record<string, string> = JSON.parse(process.env.PRINTER_MAP ?? '{}');
const HEARTBEAT_MS = 30_000;

if (!TOKEN) {
  console.error('PRINTQ_AGENT_TOKEN is required (ask the shop owner dashboard for one)');
  process.exit(1);
}

interface DispatchPayload {
  jobId: string;
  printerId: string;
  specs: { copies: number; duplex: boolean; color: boolean };
}

async function api(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API_URL}${pathname}`, {
    ...init,
    headers: { 'x-agent-token': TOKEN, 'content-type': 'application/json', ...init.headers },
  });
}

async function printJob(job: DispatchPayload): Promise<void> {
  const osPrinter = PRINTER_MAP[job.printerId];
  if (!osPrinter) {
    console.warn(`No OS printer mapped for PrintQ printer ${job.printerId} — skipping`);
    return;
  }

  // claim — if another agent got there first this 409s and we back off
  const claim = await api(`/api/agent/jobs/${job.jobId}/claim`, { method: 'POST' });
  if (!claim.ok) {
    console.log(`Job ${job.jobId}: not claimed (${claim.status})`);
    return;
  }

  const dir = await mkdtemp(path.join(tmpdir(), 'printq-agent-'));
  try {
    const fileRes = await api(`/api/agent/jobs/${job.jobId}/file`);
    if (!fileRes.ok) throw new Error(`file download failed: ${fileRes.status}`);
    const pdfPath = path.join(dir, `${job.jobId}.pdf`);
    await writeFile(pdfPath, Buffer.from(await fileRes.arrayBuffer()));

    console.log(`Printing job ${job.jobId} on "${osPrinter}" (${job.specs.copies} copies)`);
    await printer.print(pdfPath, {
      printer: osPrinter,
      copies: job.specs.copies,
      side: job.specs.duplex ? 'duplex' : 'simplex',
      monochrome: !job.specs.color,
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
}, HEARTBEAT_MS);

console.log(`PrintQ agent starting — API: ${API_URL}`);
console.log(`Mapped printers: ${Object.keys(PRINTER_MAP).length}`);
