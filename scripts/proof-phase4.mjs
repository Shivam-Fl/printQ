// Proof for Phase 4 growth features: coupons, ratings, shop directory, CSV
// export. Usage: node scripts/proof-phase4.mjs <apiLogFile>
// (run scripts/seed-coupons-proof.mjs first to seed PROOF10/PROOFEXPIRED/PROOFMAXED)
import { PDFDocument } from 'pdf-lib';
import { readFileSync } from 'node:fs';

const API = 'http://localhost:4000';
const LOG = process.argv[2];
const PHONE = '9000000066';

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
function lastLoginCode() {
  const matches = [...readFileSync(LOG, 'utf8').matchAll(/"loginCode":"(\d{6})"/g)];
  return matches.length ? matches[matches.length - 1][1] : null;
}
async function makePdf(pages) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]);
  return Buffer.from(await doc.save());
}

async function main() {
  console.log('PROOF: Phase 4 (coupons, ratings, shop directory, CSV)\n');

  const shopLogin = (
    await j('/api/auth/shop/login', { method: 'POST', body: { email: 'owner@demo.printq.local', password: 'demo-owner-pass-1' } })
  ).data;
  const shopToken = shopLogin.token;

  await j('/api/auth/student/request-otp', { method: 'POST', body: { phone: PHONE } });
  await sleep(600);
  const code = lastLoginCode();
  const verify = (await j('/api/auth/student/verify-otp', { method: 'POST', body: { phone: PHONE, otp: code } })).data;
  const studentToken = verify.token;
  ok(!!studentToken, 'student logged in');

  const fd = new FormData();
  fd.append('shopSlug', 'demo');
  fd.append('files', new Blob([await makePdf(4)], { type: 'application/pdf' }), 'coupon-proof.pdf');
  const up = await fetch(`${API}/api/files`, { method: 'POST', headers: { Authorization: `Bearer ${studentToken}` }, body: fd });
  const fileId = (await up.json()).file.id;
  let file;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    file = (await j(`/api/files/${fileId}`, { token: studentToken })).data.file;
    if (file.status === 'ready' || file.status === 'failed') break;
  }
  ok(file.status === 'ready', 'file converted (4 pages)');

  const specs = { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null };

  // --- coupons ---
  const baseQuote = (await j('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs } })).data.quote;
  ok(baseQuote.totalPaise === 800, `base price for 4 A4 B/W pages = 800 paise (${baseQuote.totalPaise})`);

  const discounted = (
    await j('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs, couponCode: 'proof10' } })
  ).data.quote;
  ok(discounted.discountPaise === 80 && discounted.totalPaise === 720, `PROOF10 (case-insensitive) takes 10% off -> 720 paise (${discounted.totalPaise})`);

  const expired = await j('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs, couponCode: 'PROOFEXPIRED' } });
  ok(expired.status === 400, 'expired coupon rejected');

  const maxed = await j('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs, couponCode: 'PROOFMAXED' } });
  ok(maxed.status === 400, 'fully-redeemed coupon rejected');

  const bogus = await j('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs, couponCode: 'NOPE_NOT_REAL' } });
  ok(bogus.status === 400, 'unknown coupon code rejected');

  const jobCreated = (
    await j('/api/jobs', { method: 'POST', token: studentToken, body: { fileId, specs, mode: 'instant', couponCode: 'PROOF10' } })
  ).data.job;
  ok(jobCreated.totalPaise === 720, 'job created with the discounted total');
  await j('/api/payments/mock/confirm', { method: 'POST', token: studentToken, body: { jobId: jobCreated.id } });

  // --- ratings ---
  let job;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    job = (await j(`/api/jobs/${jobCreated.id}`, { token: studentToken })).data.job;
    if (job.status === 'notified') break;
  }
  ok(job.status === 'notified', 'job reached notified');
  const rateBeforeCompleted = await j(`/api/jobs/${jobCreated.id}/rating`, { method: 'POST', token: studentToken, body: { rating: 5 } });
  ok(rateBeforeCompleted.status === 409, 'cannot rate before the job is completed');

  const release = await j('/api/shop/release', { method: 'POST', token: shopToken, body: { otp: job.otpCode } });
  ok(release.status === 200, 'shop released the job');

  // drive it to completed via a throwaway agent claim/complete (mirrors e2e.mjs's pattern)
  const jobAfterRelease = (await j(`/api/jobs/${jobCreated.id}`, { token: studentToken })).data.job;
  const agentReg = (
    await j('/api/shop/agents', { method: 'POST', token: shopToken, body: { machineLabel: 'Rating Proof PC', connectedPrinterIds: [jobAfterRelease.assignedPrinterId] } })
  ).data;
  const claimRes = await fetch(`${API}/api/agent/jobs/${jobCreated.id}/claim`, { method: 'POST', headers: { 'x-agent-token': agentReg.token } });
  ok(claimRes.status === 200, 'agent claimed the job');
  await fetch(`${API}/api/agent/jobs/${jobCreated.id}/complete`, { method: 'POST', headers: { 'x-agent-token': agentReg.token } });
  await j(`/api/shop/jobs/${jobCreated.id}/handover`, { method: 'POST', token: shopToken });

  const completedJob = (await j(`/api/jobs/${jobCreated.id}`, { token: studentToken })).data.job;
  ok(completedJob.status === 'completed', 'job completed');

  const rated = await j(`/api/jobs/${jobCreated.id}/rating`, { method: 'POST', token: studentToken, body: { rating: 5, reviewText: 'Great!' } });
  ok(rated.status === 200, 'rated the completed job 5 stars');

  const rateAgain = await j(`/api/jobs/${jobCreated.id}/rating`, { method: 'POST', token: studentToken, body: { rating: 1 } });
  ok(rateAgain.status === 409, 'cannot rate the same job twice');

  const publicShop = (await j('/api/public/shops/demo')).data.shop;
  ok(publicShop.rating.average != null && publicShop.rating.count >= 1, `average rating now visible (${publicShop.rating.average}★ · ${publicShop.rating.count})`);

  // --- shop directory ---
  const dirAll = (await j('/api/public/shops')).data.shops;
  ok(dirAll.some((s) => s.slug === 'demo'), 'shop directory lists the demo shop with no query');
  const dirSearch = (await j(`/api/public/shops?q=${encodeURIComponent('demo')}`)).data.shops;
  ok(dirSearch.some((s) => s.slug === 'demo'), 'shop directory search by name finds the demo shop');
  const dirMiss = (await j('/api/public/shops?q=zzz_no_such_shop_zzz')).data.shops;
  ok(dirMiss.length === 0, 'shop directory search with no matches returns empty');

  // --- CSV export ---
  const csvRes = await fetch(`${API}/api/shop/history.csv`, { headers: { Authorization: `Bearer ${shopToken}` } });
  const csvText = await csvRes.text();
  ok(csvRes.status === 200 && csvRes.headers.get('content-type')?.includes('text/csv'), 'CSV export returns text/csv');
  ok(csvText.startsWith('Date,Student,File,Printer,Status,Amount (INR),Discount (INR),Payment'), 'CSV has the expected header row');
  ok(csvText.includes('coupon-proof.pdf'), 'CSV includes the just-completed job');

  console.log(`\nPROOF PASSED — ${pass} assertions ✓`);
}

main().catch((err) => {
  console.error('\nPROOF FAILED:', err.message);
  process.exit(1);
});
