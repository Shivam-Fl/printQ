// Shared helpers for the UX-redesign evidence scripts (local stack only).
// Talks to the local dev API on :4000. Never point this at production.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const API = process.env.UX_API ?? 'http://localhost:4000';
export const WEB = process.env.UX_WEB ?? 'http://localhost:5173';
export const SCRATCH = process.env.UX_SCRATCH;
if (!SCRATCH) throw new Error('Set UX_SCRATCH to the scratch folder (holds api.log and state.json)');
export const API_LOG = `${SCRATCH}/api.log`;
export const STATE = `${SCRATCH}/state.json`;

/** The demo campus point every fixture shop sits on (New Delhi). */
export const SHOP_POINT = { latitude: 28.6139, longitude: 77.209 };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadState() {
  return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
}
export function saveState(state) {
  writeFileSync(STATE, JSON.stringify(state, null, 2));
}

export async function api(path, { method = 'GET', token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: formData ?? (body ? JSON.stringify(body) : undefined) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function must(label, promise, ok = (r) => r.status >= 200 && r.status < 300) {
  const r = await promise;
  if (!ok(r)) throw new Error(`${label} failed: ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

export async function waitFor(label, check, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(300);
  }
  throw new Error(`Timed out: ${label}`);
}

function latestLoginOtp(phone) {
  const log = readFileSync(API_LOG, 'utf8');
  const digits = phone.replace(/\D/g, '');
  const matches = [...log.matchAll(/"phone":"([^"]+)","loginCode":"(\d{6})"/g)];
  return matches.reverse().find((m) => m[1].replace(/\D/g, '').endsWith(digits))?.[2] ?? null;
}

let lastOtpRequestAt = 0;
/** Real phone-OTP login (console provider). Spaced out to respect the 5/min per-IP limit. */
export async function loginStudent(phone, name) {
  const wait = lastOtpRequestAt + 13_000 - Date.now();
  if (wait > 0) await sleep(wait);
  lastOtpRequestAt = Date.now();
  const before = latestLoginOtp(phone);
  await must('request-otp', api('/api/auth/student/request-otp', { method: 'POST', body: { phone } }));
  const code = await waitFor('login code in api.log', async () => {
    const c = latestLoginOtp(phone);
    return c && c !== before ? c : null;
  });
  const v = await must('verify-otp', api('/api/auth/student/verify-otp', { method: 'POST', body: { phone, otp: code } }));
  if (name) await api('/api/auth/student/me', { method: 'PATCH', token: v.token, body: { name } });
  return v.token;
}

/** A readable multi-page PDF (title + page numbers) so previews look real. */
export async function makePdf(pages, title = 'Assignment') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 0; i < pages; i += 1) {
    const page = doc.addPage([595, 842]);
    page.drawText(title, { x: 60, y: 760, size: 22, font: bold, color: rgb(0.1, 0.12, 0.2) });
    for (let line = 0; line < 22; line += 1) {
      page.drawRectangle({ x: 60, y: 700 - line * 26, width: 470 - ((line * 37) % 120), height: 7, color: rgb(0.82, 0.85, 0.9) });
    }
    page.drawText(`Page ${i + 1} of ${pages}`, { x: 60, y: 60, size: 10, font, color: rgb(0.4, 0.4, 0.45) });
  }
  return Buffer.from(await doc.save());
}

export async function upload(token, shopSlug, pages, name) {
  const formData = new FormData();
  formData.append('shopSlug', shopSlug);
  formData.append('files', new Blob([await makePdf(pages, name.replace(/\.pdf$/i, ''))], { type: 'application/pdf' }), name);
  const up = await must(`upload ${name}`, api('/api/files', { method: 'POST', token, formData }));
  const fileId = up.file.id;
  await waitFor(`${name} ready`, async () => {
    const r = await api(`/api/files/${fileId}`, { token });
    return r.data.file?.status === 'ready' ? r.data.file : null;
  });
  return fileId;
}

export async function createOrder(token, shopSlug, { pages = 4, name = 'notes.pdf', specs = {}, mode = 'instant', scheduledTime } = {}) {
  const fileId = await upload(token, shopSlug, pages, name);
  const fullSpecs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null, ...specs };
  const created = await must('create job', api('/api/jobs', {
    method: 'POST', token,
    body: { fileId, specs: fullSpecs, mode, ...(scheduledTime ? { scheduledTime } : {}) },
  }));
  return { jobId: created.job.id, fileId };
}

export const arrivalProof = (point = SHOP_POINT) => ({ ...point, accuracyM: 8, measuredAt: new Date().toISOString() });

export async function checkIn(token, jobId, point) {
  return must('check-in', api(`/api/jobs/${jobId}/check-in`, { method: 'POST', token, body: arrivalProof(point) }));
}

export async function studentJob(token, jobId) {
  return (await api(`/api/jobs/${jobId}`, { token })).data.job;
}
