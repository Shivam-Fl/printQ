// Drive a real job up to otp_verified + release, register an agent, and emit
// the env the REAL agent needs to actually print. Usage:
//   node scripts/physical.mjs <apiLogFile> <printerName> <outEnvFile>
import { PDFDocument } from 'pdf-lib';
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'http://localhost:4000';
const [LOG, PRINTER_NAME, OUT_ENV] = process.argv.slice(2);
const PHONE = '9000000077';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const lastCode = () => {
  const m = [...readFileSync(LOG, 'utf8').matchAll(/"loginCode":"(\d{6})"/g)];
  return m.length ? m[m.length - 1][1] : null;
};

// 1. student login
await j('/api/auth/student/request-otp', { method: 'POST', body: { phone: PHONE } });
await sleep(700);
const token = (await j('/api/auth/student/verify-otp', { method: 'POST', body: { phone: PHONE, otp: lastCode() } })).data.token;
await j('/api/auth/student/me', { method: 'PATCH', token, body: { name: 'Print Proof' } });

// 2. upload a real 2-page PDF
const doc = await PDFDocument.create();
const { rgb } = await import('pdf-lib');
for (let i = 0; i < 2; i++) {
  const p = doc.addPage([595, 842]);
  p.drawText(`PrintQ physical proof — page ${i + 1}`, { x: 60, y: 760, size: 24, color: rgb(0, 0, 0) });
}
const pdfBytes = Buffer.from(await doc.save());
const fd = new FormData();
fd.append('shopSlug', 'demo');
fd.append('files', new Blob([pdfBytes], { type: 'application/pdf' }), 'proof.pdf');
const up = await fetch(`${API}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
const fileId = (await up.json()).file.id;
let file;
for (let i = 0; i < 20; i++) { await sleep(500); file = (await j(`/api/files/${fileId}`, { token })).data.file; if (file.status !== 'converting' && file.status !== 'uploaded') break; }
if (file.status !== 'ready') throw new Error('convert failed: ' + file.status);

// 3. simple A4 B/W job, pay
const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };
const jobId = (await j('/api/jobs', { method: 'POST', token, body: { fileId, specs, mode: 'instant' } })).data.job.id;
await j('/api/payments/mock/confirm', { method: 'POST', token, body: { jobId } });

// 4. wait notified, read OTP
let job;
for (let i = 0; i < 20; i++) { await sleep(500); job = (await j(`/api/jobs/${jobId}`, { token })).data.job; if (job.status === 'notified') break; }
if (job.status !== 'notified') throw new Error('not notified: ' + job.status);

// 5. shop release
const shopToken = (await j('/api/auth/shop/login', { method: 'POST', body: { email: 'owner@demo.printq.local', password: 'demo-owner-pass-1' } })).data.token;
const printers = (await j('/api/shop/printers', { token: shopToken })).data.printers;
const rel = await j('/api/shop/release', { method: 'POST', token: shopToken, body: { otp: job.otpCode } });
if (!rel.data.ok) throw new Error('release failed: ' + JSON.stringify(rel.data));

// 6. register agent for ALL printers, map every printer id to the test printer
const agent = (await j('/api/shop/agents', { method: 'POST', token: shopToken, body: { machineLabel: 'Proof PC', connectedPrinterIds: printers.map((p) => p.id) } })).data;
const printerMap = Object.fromEntries(printers.map((p) => [p.id, PRINTER_NAME]));

writeFileSync(OUT_ENV, JSON.stringify({ agentToken: agent.token, apiUrl: API, printerMap, jobId, assignedPrinterId: job.assignedPrinterId ?? rel.data.job?.id }, null, 2));
console.log('READY jobId=' + jobId + ' otp_verified, agent registered. env ->', OUT_ENV);
