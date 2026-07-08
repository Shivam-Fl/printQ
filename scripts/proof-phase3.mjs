// Proof for Phase 3 backend pieces: notify-when-open (shop reopen push) and
// downloadable receipts. Usage: node scripts/proof-phase3.mjs <apiLogFile>
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:4000';
const LOG = process.argv[2];
const PHONE = '9000000077';

let pass = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`ASSERT FAILED: ${label}`);
  pass++;
  console.log(`  ✓ ${label}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function j(path, opts = {}) {
  const { method = 'GET', token, body } = opts;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
function lastMatch(re) {
  const matches = [...readFileSync(LOG, 'utf8').matchAll(re)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

async function main() {
  console.log('PROOF: Phase 3 (notify-when-open, receipts)\n');

  const shop = (
    await j('/api/auth/shop/login', { method: 'POST', body: { email: 'owner@demo.printq.local', password: 'demo-owner-pass-1' } })
  ).data;
  const shopToken = shop.token;

  await j('/api/auth/student/request-otp', { method: 'POST', body: { phone: PHONE } });
  await sleep(600);
  const loginCode = lastMatch(/"loginCode":"(\d{6})"/g);
  const verify = (await j('/api/auth/student/verify-otp', { method: 'POST', body: { phone: PHONE, otp: loginCode } })).data;
  const studentToken = verify.token;
  ok(!!studentToken, 'student logged in');

  // --- notify-when-open ---
  const printers = (await j('/api/shop/printers', { token: shopToken })).data.printers;
  const originalStatuses = printers.map((p) => ({ id: p.id, status: p.status }));
  for (const p of printers) {
    await j(`/api/shop/printers/${p.id}`, { method: 'PATCH', token: shopToken, body: { status: 'offline' } });
  }
  const publicShop = (await j('/api/public/shops/demo')).data.shop;
  ok(publicShop.open === false, 'shop now shows closed (all printers offline)');

  const interest = await j('/api/public/shops/demo/notify-when-open', { method: 'POST', token: studentToken });
  ok(interest.status === 200 && interest.data.alreadyOpen === false, 'student registered interest in reopening');

  const already = await j('/api/public/shops/demo/notify-when-open', { method: 'POST', token: studentToken });
  ok(already.status === 200, 'registering interest again is a harmless no-op (upsert)');

  // bring one printer back online -> should trigger the reopen notify + clear interest
  await j(`/api/shop/printers/${printers[0].id}`, { method: 'PATCH', token: shopToken, body: { status: 'online' } });
  await sleep(400);
  const reopenedShop = (await j('/api/public/shops/demo')).data.shop;
  ok(reopenedShop.open === true, 'shop shows open again after a printer comes back online');

  // registering interest again should now short-circuit as alreadyOpen (no duplicate row)
  const afterOpen = await j('/api/public/shops/demo/notify-when-open', { method: 'POST', token: studentToken });
  ok(afterOpen.data.alreadyOpen === true, 'notify-when-open recognizes the shop is already open');

  // restore original printer statuses
  for (const p of originalStatuses) {
    await j(`/api/shop/printers/${p.id}`, { method: 'PATCH', token: shopToken, body: { status: p.status } });
  }

  // --- receipts ---
  const fd = new FormData();
  fd.append('shopSlug', 'demo');
  fd.append('files', new Blob([await makePdf(2)], { type: 'application/pdf' }), 'receipt-proof.pdf');
  const up = await fetch(`${API}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${studentToken}` }, body: fd });
  const fileId = (await up.json()).file.id;
  let file;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    file = (await j(`/api/files/${fileId}`, { token: studentToken })).data.file;
    if (file.status === 'ready' || file.status === 'failed') break;
  }
  ok(file.status === 'ready', 'file converted');

  const specs = { copies: 2, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };
  const jobCreated = (
    await j('/api/jobs', { method: 'POST', token: studentToken, body: { fileId, specs, mode: 'instant' } })
  ).data.job;
  await j('/api/payments/mock/confirm', { method: 'POST', token: studentToken, body: { jobId: jobCreated.id } });

  const studentReceipt = await fetch(`${API}/api/jobs/${jobCreated.id}/receipt`, {
    headers: { Authorization: `Bearer ${studentToken}` },
  });
  const studentBytes = Buffer.from(await studentReceipt.arrayBuffer());
  ok(studentReceipt.status === 200 && studentBytes.slice(0, 4).toString() === '%PDF', 'student can download a PDF receipt');

  const otherStudentReceipt = await fetch(`${API}/api/jobs/${jobCreated.id}/receipt`, {
    headers: { Authorization: `Bearer ${(await j('/api/auth/student/verify-otp', { method: 'POST', body: { phone: '9000000078', otp: '000000' } })).data.token ?? ''}` },
  });
  ok(otherStudentReceipt.status !== 200, 'a different/invalid token cannot fetch someone else\'s receipt');

  const shopReceipt = await fetch(`${API}/api/shop/jobs/${jobCreated.id}/receipt`, {
    headers: { Authorization: `Bearer ${shopToken}` },
  });
  const shopBytes = Buffer.from(await shopReceipt.arrayBuffer());
  ok(shopReceipt.status === 200 && shopBytes.slice(0, 4).toString() === '%PDF', 'shop can download the same job\'s receipt');

  console.log(`\nPROOF PASSED — ${pass} assertions ✓`);
}

main().catch((err) => {
  console.error('\nPROOF FAILED:', err.message);
  process.exit(1);
});
