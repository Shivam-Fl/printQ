// Full end-to-end flow against the running API (no browser needed):
// multi-file upload -> merge -> price -> pay -> notify -> OTP release ->
// agent claim/print/complete -> handover -> completed. Plus custom-paper pricing.
//
// Usage: node scripts/e2e.mjs <apiLogFile>
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:4000';
const LOG = process.argv[2];
const PHONE = '9000000042';

let pass = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  pass++;
  console.log(`  ✓ ${label}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, { method = 'GET', token, agentToken, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (agentToken) headers['x-agent-token'] = agentToken;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function lastLoginCode() {
  const text = readFileSync(LOG, 'utf8');
  const matches = [...text.matchAll(/"loginCode":"(\d{6})"/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

async function main() {
  console.log('E2E: student journey (multi-file → print)');

  // 1. login
  await j('/api/auth/student/request-otp', { method: 'POST', body: { phone: PHONE } });
  await sleep(600);
  const code = lastLoginCode();
  ok(/^\d{6}$/.test(code ?? ''), `login OTP delivered (${code})`);
  const verify = await j('/api/auth/student/verify-otp', { method: 'POST', body: { phone: PHONE, otp: code } });
  ok(verify.status === 200 && verify.data.token, 'OTP verified → token');
  const token = verify.data.token;
  await j('/api/auth/student/me', { method: 'PATCH', token, body: { name: 'E2E Student' } });

  // 2. multi-file upload (3-page + 2-page) → one merged job
  const fd = new FormData();
  fd.append('shopSlug', 'demo');
  fd.append('files', new Blob([await makePdf(3)], { type: 'application/pdf' }), 'notes.pdf');
  fd.append('files', new Blob([await makePdf(2)], { type: 'application/pdf' }), 'cover.pdf');
  const up = await fetch(`${API}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: fd });
  const upData = await up.json();
  ok(up.status === 201 && upData.file?.id, 'uploaded 2 files as one');
  const fileId = upData.file.id;

  let file;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    file = (await j(`/api/files/${fileId}`, { token })).data.file;
    if (file.status === 'ready' || file.status === 'failed') break;
  }
  ok(file.status === 'ready', 'files converted + merged');
  ok(file.pages === 5, `merged page count = 3+2 = ${file.pages}`);

  // 3. price (2 copies, spiral binding) — server computed
  const specs = { copies: 2, paperSize: 'A4', color: false, duplex: true, binding: 'spiral_binding', pageRange: null };
  const quote = (await j('/api/jobs/quote', { method: 'POST', token, body: { fileId, specs } })).data.quote;
  ok(quote.totalPaise === 5 * 2 * 200 + 3000, `price = 5pg×2×₹2 + ₹30 spiral = ₹${quote.totalPaise / 100}`);

  // 4. create + pay
  const created = (await j('/api/jobs', { method: 'POST', token, body: { fileId, specs, mode: 'instant' } })).data;
  const jobId = created.job.id;
  ok(!!jobId, 'job created (pending_payment)');
  await j('/api/payments/mock/confirm', { method: 'POST', token, body: { jobId } });

  // 5. wait for notified + read in-app OTP
  let job;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    job = (await j(`/api/jobs/${jobId}`, { token })).data.job;
    if (job.status === 'notified') break;
  }
  ok(job.status === 'notified', 'job reached front of queue → notified');
  ok(/^\d{6}$/.test(job.otpCode ?? ''), `release OTP visible in student app (${job.otpCode})`);
  const releaseOtp = job.otpCode;

  // 6. shop releases with the OTP
  const shop = (await j('/api/auth/shop/login', { method: 'POST', body: { email: 'owner@demo.printq.local', password: 'demo-owner-pass-1' } })).data;
  const shopToken = shop.token;
  const printers = (await j('/api/shop/printers', { token: shopToken })).data.printers;
  const spiralPrinter = printers.find((p) => p.finishingOptions.includes('spiral_binding'));
  ok(!!spiralPrinter, 'a printer supports spiral binding');

  const release = await j('/api/shop/release', { method: 'POST', token: shopToken, body: { otp: releaseOtp } });
  ok(release.status === 200 && release.data.ok, 'shop OTP release → job sent to printer');

  // 7. agent claims + prints + completes
  const agent = (await j('/api/shop/agents', { method: 'POST', token: shopToken, body: { machineLabel: 'E2E PC', connectedPrinterIds: [spiralPrinter.id] } })).data;
  const agentToken = agent.token;
  ok(!!agentToken, 'agent registered with token');

  const pending = (await j('/api/agent/jobs/pending', { agentToken })).data.jobs;
  ok(pending.some((p) => p.id === jobId), 'agent sees the verified job as pending');

  const claim = await j(`/api/agent/jobs/${jobId}/claim`, { method: 'POST', agentToken });
  ok(claim.status === 200, 'agent claimed the job → printing');

  const fileRes = await fetch(`${API}/api/agent/jobs/${jobId}/file`, { headers: { 'x-agent-token': agentToken } });
  const bytes = Buffer.from(await fileRes.arrayBuffer());
  ok(fileRes.status === 200 && bytes.slice(0, 4).toString() === '%PDF', 'agent downloaded the print-ready PDF');

  const completion = await j(`/api/agent/jobs/${jobId}/complete`, {
    method: 'POST',
    agentToken,
    body: { outcome: 'simulator_complete' },
  });
  ok(completion.status === 200 && completion.data.finishingRequired, 'simulator completion is confirmed and enters manual finishing');
  const finishing = await j(`/api/shop/jobs/${jobId}/finishing-complete`, { method: 'POST', token: shopToken });
  ok(finishing.status === 200, 'shop confirms manual finishing');
  await j(`/api/shop/jobs/${jobId}/handover`, { method: 'POST', token: shopToken });

  const finalJob = (await j(`/api/jobs/${jobId}`, { token })).data.job;
  ok(finalJob.status === 'completed', 'job handed over → completed');

  // 8. custom "college sheet" paper via settings, priced correctly
  const opts = (await j('/api/shop/me', { token: shopToken })).data.shop.printOptions;
  opts.papers.push({ id: 'college', label: 'College sheet', bwPaise: 100, colorPaise: null });
  const saved = await j('/api/shop/me', { method: 'PATCH', token: shopToken, body: { printOptions: opts } });
  ok(saved.status === 200, 'owner added a custom "College sheet" paper');

  const collegeQuote = (await j('/api/jobs/quote', { method: 'POST', token, body: { fileId, specs: { ...specs, paperSize: 'college', binding: null, copies: 1 } } })).data.quote;
  ok(collegeQuote.totalPaise === 5 * 1 * 100, `college sheet priced = 5pg × ₹1 = ₹${collegeQuote.totalPaise / 100}`);

  // college sheet is B/W only → colour must be rejected
  const badColor = await j('/api/jobs/quote', { method: 'POST', token, body: { fileId, specs: { ...specs, paperSize: 'college', color: true, binding: null } } });
  ok(badColor.status === 400, 'colour on a B/W-only sheet is rejected server-side');

  console.log(`\nE2E PASSED — ${pass} assertions ✓`);
}

main().catch((err) => {
  console.error('\nE2E FAILED:', err.message);
  process.exit(1);
});
