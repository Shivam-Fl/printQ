// A stand-in for a real Windows counter PC, for local UX testing only.
// Speaks the same agent protocol as apps/agent, but finishes every print the
// way a real spooler does ("spool_accepted"), so staff must confirm
// "Printed successfully" -- the real production path the simulator skips.
//
// env: FAKE_AGENT_TOKEN (required), UX_API (default http://localhost:4000),
//      FAKE_PRINTERS  JSON [{name, paperSizes}]  (default: one laser + one colour inkjet)
//      FAKE_DELAY_MS  spool delay (default 1500)
//      FAKE_JAM_COPIES  jobs with exactly this many copies fail their first attempt (default 7)
import { randomUUID } from 'node:crypto';
import { io } from 'socket.io-client';

const API = process.env.UX_API ?? 'http://localhost:4000';
const TOKEN = process.env.FAKE_AGENT_TOKEN;
if (!TOKEN) throw new Error('FAKE_AGENT_TOKEN is required');
const SESSION = randomUUID();
const PRINTERS = process.env.FAKE_PRINTERS
  ? JSON.parse(process.env.FAKE_PRINTERS)
  : [
      { name: 'HP LaserJet Pro M126nw', paperSizes: ['A4'] },
      { name: 'Epson L3250 Series', paperSizes: ['A4', 'A3'] },
    ];
const DELAY = Number(process.env.FAKE_DELAY_MS ?? 1500);
const JAM_COPIES = Number(process.env.FAKE_JAM_COPIES ?? 7);
const jammed = new Set();
const inFlight = new Set();

const call = (path, init = {}) =>
  fetch(`${API}${path}`, {
    ...init,
    headers: { 'x-agent-token': TOKEN, 'x-agent-session': SESSION, 'content-type': 'application/json', ...init.headers },
  });

async function report() {
  await call('/api/agent/printers', { method: 'POST', body: JSON.stringify({ printers: PRINTERS }) }).catch(() => undefined);
}

async function print(job) {
  if (inFlight.has(job.jobId)) return;
  inFlight.add(job.jobId);
  try {
    const claim = await call(`/api/agent/jobs/${job.jobId}/claim`, { method: 'POST' });
    if (!claim.ok) return;
    const file = await call(`/api/agent/jobs/${job.jobId}/file`);
    if (!file.ok) throw new Error(`file ${file.status}`);
    await file.arrayBuffer();
    await new Promise((r) => setTimeout(r, DELAY));
    if (job.specs?.copies === JAM_COPIES && !jammed.has(job.jobId)) {
      jammed.add(job.jobId);
      throw new Error('Paper jam in tray 1');
    }
    const done = await call(`/api/agent/jobs/${job.jobId}/complete`, { method: 'POST', body: JSON.stringify({ outcome: 'spool_accepted' }) });
    console.log(`job ${job.jobId}: spool accepted (${done.status})`);
  } catch (err) {
    console.log(`job ${job.jobId}: failed - ${err.message}`);
    await call(`/api/agent/jobs/${job.jobId}/fail`, { method: 'POST', body: JSON.stringify({ reason: err.message }) }).catch(() => undefined);
  } finally {
    inFlight.delete(job.jobId);
  }
}

async function drain() {
  const res = await call('/api/agent/jobs/pending').catch(() => null);
  if (!res?.ok) return;
  const { jobs } = await res.json();
  for (const j of jobs) await print({ jobId: j.id, printerId: j.assignedPrinterId, specs: j.specs });
}

const socket = io(API, { auth: { agentToken: TOKEN, sessionId: SESSION } });
socket.on('connect', () => { console.log('fake counter PC connected'); void report(); void drain(); });
socket.on('job:dispatch', (p) => void print(p));
socket.on('printer:test_page', async (p) => {
  await new Promise((r) => setTimeout(r, DELAY));
  await call('/api/agent/printer-tests/result', { method: 'POST', body: JSON.stringify({ testId: p.testId, printerId: p.printerId, status: 'spool_accepted' }) }).catch(() => undefined);
});
socket.on('connect_error', (e) => console.log('connect_error', e.message));
setInterval(() => {
  void call('/api/agent/heartbeat', { method: 'POST', body: JSON.stringify({ inFlightJobIds: [...inFlight] }) }).catch(() => undefined);
  void report();
}, 15_000);
