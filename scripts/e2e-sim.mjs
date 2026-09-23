/**
 * Launch-grade E2E: boots the built API and the real PrintQ agent in simulator
 * mode, then proves onboarding -> upload -> attended counter payment ->
 * queue -> code release -> failed print -> retry -> pickup and refunds.
 *
 * Run after `npm run build`, or use `npm run test:launch`.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import Redis from 'ioredis';
import { createInterface } from 'node:readline/promises';
import argon2 from 'argon2';

const ROOT = process.cwd();
const PORT = 4010;
const remote = Boolean(process.env.PRINTQ_E2E_API_URL);
const API = process.env.PRINTQ_E2E_API_URL ?? `http://localhost:${PORT}`;
const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tempDir = path.join(ROOT, '.tmp', `e2e-sim-${stamp}`);
const outputDir = path.join(tempDir, 'printed');
const storageDir = path.join(tempDir, 'storage');
const redisUrl = new URL(process.env.PRINTQ_E2E_REDIS_URL ?? 'redis://localhost:6380');
redisUrl.pathname = '/15';
const isolatedRedisUrl = redisUrl.toString();
const processes = [];
let apiOutput = '';
let agentOutput = '';
let assertions = 0;

const arrivalProof = () => ({
  latitude: 28.6139,
  longitude: 77.209,
  accuracyM: 8,
  measuredAt: new Date().toISOString(),
});

function assert(condition, label) {
  if (!condition) throw new Error(`ASSERT FAILED: ${label}`);
  assertions += 1;
  console.log(`  ✓ ${label}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, check, timeoutMs = remote ? 120_000 : 40_000) {
  const deadline = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < deadline) {
    latest = await check();
    if (latest) return latest;
    await sleep(remote ? 1000 : 250);
  }
  throw new Error(`Timed out waiting for ${label}${latest ? ` (${JSON.stringify(latest)})` : ''}`);
}

function start(name, entry, env = {}, args = []) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const collect = (chunk) => {
    const text = chunk.toString();
    if (name === 'api') apiOutput += text;
    else agentOutput += text;
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  processes.push(child);
  return child;
}

async function request(pathname, { method = 'GET', token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: formData ?? (body ? JSON.stringify(body) : undefined),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function latestLoginOtp(phone) {
  const matches = [...apiOutput.matchAll(/"phone":"([^"]+)","loginCode":"(\d{6})"/g)];
  const digits = phone.replace(/\D/g, '');
  return matches.reverse().find((match) => match[1].replace(/\D/g, '').endsWith(digits))?.[2] ?? null;
}

async function makePdf(pages) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page += 1) document.addPage([595, 842]);
  return Buffer.from(await document.save());
}

async function upload(token, shopSlug, pages, name) {
  const formData = new FormData();
  formData.append('shopSlug', shopSlug);
  formData.append('files', new Blob([await makePdf(pages)], { type: 'application/pdf' }), name);
  const uploaded = await request('/api/files', { method: 'POST', token, formData });
  assert(uploaded.status === 201 && uploaded.data.file?.id, `${name} uploaded`);
  const fileId = uploaded.data.file.id;
  const file = await waitFor(`${name} conversion`, async () => {
    const result = await request(`/api/files/${fileId}`, { token });
    return result.data.file?.status === 'ready' ? result.data.file : null;
  });
  assert(file.pages === pages, `${name} converted with ${pages} page${pages === 1 ? '' : 's'}`);
  return fileId;
}

async function createPayAtShop(token, fileId, specs) {
  const created = await request('/api/jobs', {
    method: 'POST',
    token,
    body: { fileId, specs, mode: 'instant' },
  });
  assert(
    created.status === 201
      && created.data.job?.id
      && created.data.checkout?.mode === 'pay_at_shop'
      && created.data.checkout?.amountPaise === created.data.job.totalPaise,
    'student receives one server-priced pay-at-shop checkout',
  );
  return created.data.job.id;
}

async function main() {
  const apiEntry = path.join(ROOT, 'apps', 'api', 'dist', 'server.js');
  const agentEntry = path.join(ROOT, 'apps', 'agent', 'dist', 'index.js');
  if ((!remote && !existsSync(apiEntry)) || !existsSync(agentEntry)) {
    throw new Error('Built API/agent not found. Run `npm run build` first.');
  }
  await mkdir(outputDir, { recursive: true });

  // CI creates a unique, in-memory platform-admin credential solely to prove
  // that shops cannot self-publish. It is passed only to the spawned API and
  // is never written to disk or printed. Remote development runs must supply
  // a separate pre-provisioned test administrator through their secret store.
  const remoteAdminEmail = process.env.PRINTQ_E2E_ADMIN_EMAIL;
  const remoteAdminPassword = process.env.PRINTQ_E2E_ADMIN_PASSWORD;
  if (remote && (!remoteAdminEmail || !remoteAdminPassword)) {
    throw new Error('Remote simulator requires PRINTQ_E2E_ADMIN_EMAIL and PRINTQ_E2E_ADMIN_PASSWORD from the isolated development secret store');
  }
  const adminCredentials = remote
    ? { email: remoteAdminEmail, password: remoteAdminPassword, passwordHash: undefined }
    : (() => {
      const password = randomBytes(32).toString('base64url');
      return { email: `e2e-admin-${stamp}@printq.local`, password, passwordHash: undefined };
    })();
  if (!remote) adminCredentials.passwordHash = await argon2.hash(adminCredentials.password, { type: argon2.argon2id });

  if (!remote) {

  // A dedicated Redis DB prevents a concurrently running development worker
  // from consuming simulator conversion/timer jobs with a different storage
  // directory. Flushes are scoped to DB 15 only.
  const testRedis = new Redis(isolatedRedisUrl, { maxRetriesPerRequest: 1 });
  await testRedis.flushdb();
  await testRedis.quit();

  console.log('E2E simulator: booting production builds');
  start('api', apiEntry, {
    PORT: String(PORT),
    PUBLIC_WEB_URL: 'http://localhost:4173',
    CORS_ORIGINS: 'http://localhost:4173',
    PAYMENT_PROVIDER: 'mock',
    PLATFORM_MARKUP_BPS: '2500',
    SHOP_COLLECTION_MODE: 'disabled',
    SMS_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    // Explicit test-only opt-in. Production configuration rejects this value.
    ALLOW_SIMULATED_PRINT_COMPLETION: 'true',
    LOG_LEVEL: 'info',
    REDIS_URL: isolatedRedisUrl,
    STORAGE_LOCAL_DIR: storageDir,
    ADMIN_BOOTSTRAP_EMAIL: adminCredentials.email,
    ADMIN_BOOTSTRAP_PASSWORD_HASH: adminCredentials.passwordHash,
  });
  }
  console.log(`Testing ${API}${remote ? ' (remote test deployment; no database/Redis resets)' : ''}`);
  await waitFor('API health', async () => fetch(`${API}/healthz`).then((response) => response.ok).catch(() => false));
  assert(true, 'built API is healthy');

  console.log('\nPlatform campus verification, shop onboarding and simulated printer setup');
  const adminLogin = await request('/api/admin/auth/login', {
    method: 'POST',
    body: { email: adminCredentials.email, password: adminCredentials.password },
  });
  assert(adminLogin.status === 200 && adminLogin.data.token, 'separately authenticated platform administrator signed in');
  const adminToken = adminLogin.data.token;
  const campusResult = await request('/api/admin/campuses', {
    method: 'POST',
    token: adminToken,
    body: {
      name: `PrintQ Test Campus ${stamp}`,
      address: 'Test Campus Road, New Delhi',
      latitude: 28.6139,
      longitude: 77.209,
    },
  });
  assert(campusResult.status === 201 && campusResult.data.campus?.id, 'canonical active campus created by administrator');
  const campusId = campusResult.data.campus.id;

  const email = `owner-${stamp}@printq.local`;
  const registered = await request('/api/auth/shop/register', {
    method: 'POST',
    body: {
      shopName: `PrintQ E2E ${stamp}`,
      address: 'Test Counter, Campus Lab',
      campusName: 'PrintQ Test Campus',
      ownerName: 'E2E Owner',
      email,
      password: 'e2e-owner-pass-1',
    },
  });
  assert(registered.status === 201 && registered.data.token, 'shop owner registered');
  const shopToken = registered.data.token;
  const shopSlug = registered.data.shop.slug;

  const located = await request('/api/shop/me', {
    method: 'PATCH',
    token: shopToken,
    body: {
      campusId,
      latitude: 28.6139,
      longitude: 77.209,
      checkInRadiusM: 50,
      counterUpiVpa: 'printq-e2e@upi',
      counterUpiPayeeName: 'PrintQ E2E Shop',
    },
  });
  assert(located.status === 200 && located.data.shop?.locationUpdatedAt, 'secure arrival zone configured');
  const verifiedCounterUpi = await request('/api/shop/counter-upi/verify', {
    method: 'POST', token: shopToken, body: {},
  });
  assert(verifiedCounterUpi.status === 200 && verifiedCounterUpi.data.counterUpi?.counterUpiVerifiedAt, 'owner verified the shop merchant UPI payee');

  const printerResult = await request('/api/shop/printers', {
    method: 'POST',
    token: shopToken,
    body: {
      label: 'Front counter simulator',
      paperSizesLoaded: ['A4', 'A3'],
      colorSupport: true,
      finishingOptions: ['stapling', 'spiral_binding'],
      avgPagesPerMinute: 24,
      status: 'online',
      osPrinterName: 'PrintQ Simulator',
      mediaConfig: {
        A4: { paperSize: 'A4', bin: 'Tray 1' },
        A3: { paperSize: 'A3', bin: null },
      },
    },
  });
  assert(printerResult.status === 201, 'printer capability profile created');
  const printerId = printerResult.data.printer.id;

  const agentRegistration = await request('/api/shop/agents', {
    method: 'POST',
    token: shopToken,
    body: { machineLabel: 'E2E simulated counter PC', connectedPrinterIds: [printerId] },
  });
  assert(agentRegistration.status === 201 && agentRegistration.data.token, 'shop computer registered');
  start('agent', agentEntry, {
    PRINTQ_API_URL: API,
    PRINTQ_AGENT_TOKEN: agentRegistration.data.token,
    PRINTQ_AGENT_MODE: 'simulate',
    PRINTQ_SIM_OUTPUT_DIR: outputDir,
    PRINTQ_SIM_DELAY_MS: '200',
    PRINTQ_SIM_FAIL_FIRST: 'true',
  }, ['--simulate']);

  await waitFor('agent connection', async () => {
    const result = await request('/api/shop/agents', { token: shopToken });
    return result.data.agents?.some((agent) => agent.status === 'online' && agent.detectedPrinters?.length > 0);
  });
  assert(true, 'simulator connected and reported its virtual printer');
  const submitted = await request('/api/shop/verification/submit', { method: 'POST', token: shopToken });
  assert(submitted.status === 200 && submitted.data.verification?.status === 'submitted', 'shop independently requested verification');
  const verifiedShop = await request(`/api/admin/shops/${registered.data.user.shopId}/verify`, {
    method: 'POST', token: adminToken, body: { notes: 'CI simulator only' },
  });
  assert(verifiedShop.status === 200 && verifiedShop.data.shop?.verificationStatus === 'verified', 'administrator verified shop separately');
  const publishedShop = await request(`/api/admin/shops/${registered.data.user.shopId}/publish`, {
    method: 'POST', token: adminToken,
  });
  assert(publishedShop.status === 200 && publishedShop.data.shop?.publishedAt, 'administrator published verified shop');
  const setup = await request('/api/shop/setup-status', { token: shopToken });
  assert(setup.data.setup?.ready === true, 'setup checklist reports launch-ready');
  const publicShop = await request(`/api/public/shops/${shopSlug}`);
  assert(publicShop.data.shop?.open === true, 'student storefront opens only with a reachable agent');
  assert(!('counterUpiVpa' in publicShop.data.shop), 'merchant UPI payee is visible only on a student’s own order');
  assert(
    publicShop.data.shop?.options?.papers?.every((paper) => !('bwPaise' in paper) && !('colorPaise' in paper)),
    'public storefront never exposes the owner base rate card',
  );

  console.log('\nStudent order, queue and recovery journey');
  const phone = `9${String(Date.now()).slice(-9)}`;
  const otpRequested = await request('/api/auth/student/request-otp', { method: 'POST', body: { phone } });
  assert(otpRequested.status === 200, 'student login OTP requested');
  let loginOtp;
  if (remote) {
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
      loginOtp = (await input.question(`Enter the private backend loginCode for test phone ${phone}: `)).trim();
    } finally { input.close(); }
  } else {
    loginOtp = await waitFor('console login OTP', async () => latestLoginOtp(phone));
  }
  const verified = await request('/api/auth/student/verify-otp', { method: 'POST', body: { phone, otp: loginOtp } });
  assert(verified.status === 200 && verified.data.token, 'student OTP verified');
  const studentToken = verified.data.token;
  await request('/api/auth/student/me', { method: 'PATCH', token: studentToken, body: { name: 'E2E Student' } });

  const fileId = await upload(studentToken, shopSlug, 3, 'market-ready-test.pdf');
  const specs = { copies: 2, paperSize: 'A4', color: true, duplex: true, binding: 'stapling', pageRange: '1-2' };
  const quote = await request('/api/jobs/quote', { method: 'POST', token: studentToken, body: { fileId, specs } });
  assert(quote.status === 200 && quote.data.quote.pagesPerCopy === 2, 'server quote honors page range and options');
  assert(quote.data.quote.totalPaise === 5000, '25% platform markup turns the ₹40 shop base into one ₹50 student price');
  assert(
    !('pagesTotalPaise' in quote.data.quote) && !('bindingPaise' in quote.data.quote),
    'student quote returns only the final payable amount',
  );
  const jobId = await createPayAtShop(studentToken, fileId, specs);

  const prepared = await waitFor('prepared remote order', async () => {
    const result = await request(`/api/jobs/${jobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival' ? result.data.job : null;
  });
  assert(prepared.position === null, 'remote upload does not occupy the physical line');
  assert(prepared.otpCode === null, 'counter code stays hidden before physical check-in');
  assert(prepared.paymentStatus === 'counter_due', 'upload does not mark counter payment received');
  assert(prepared.shop.counterUpi?.vpa === 'printq-e2e@upi', 'own order shows the verified shop merchant UPI payee');
  const remoteCheckIn = await request(`/api/jobs/${jobId}/check-in`, {
    method: 'POST',
    token: studentToken,
    body: { ...arrivalProof(), latitude: 28.6239 },
  });
  assert(remoteCheckIn.status === 409, 'geofence rejects a check-in away from the shop');
  const checkedIn = await request(`/api/jobs/${jobId}/check-in`, {
    method: 'POST',
    token: studentToken,
    body: arrivalProof(),
  });
  assert(checkedIn.status === 200 && checkedIn.data.job?.status === 'queued', 'arrival check-in joins the live walk-in line');
  const live = await request(`/api/jobs/${jobId}`, { token: studentToken });
  assert(live.data.job.position === 1 && /^\d{6}$/.test(live.data.job.otpCode ?? ''), 'check-in assigns a shop-wide position and automatically reveals the near-front code');
  const counterPrompt = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: live.data.job.otpCode },
  });
  assert(
    counterPrompt.status === 200
      && counterPrompt.data.requiresPaymentConfirmation === true
      && counterPrompt.data.counterPaymentAmountPaise === 5000,
    'counter code asks staff to verify the exact final amount before printing',
  );
  const beforeCounterPayment = await request(`/api/jobs/${jobId}`, { token: studentToken });
  assert(beforeCounterPayment.data.job.paymentStatus === 'counter_due' && beforeCounterPayment.data.job.status === 'queued', 'code lookup alone cannot mark payment received or print');
  const released = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: {
      otp: live.data.job.otpCode,
      paymentConfirmation: { method: 'cash' },
      ...(counterPrompt.data.selectedPrinterId ? { printerId: counterPrompt.data.selectedPrinterId } : {}),
    },
  });
  assert(released.status === 200 && released.data.ok, 'staff cash confirmation releases the checked-in job');

  await waitFor('simulated first-attempt failure', async () => {
    const result = await request(`/api/jobs/${jobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  assert(agentOutput.includes('simulated printer jam on first attempt'), 'simulator exercised a printer-jam failure');
  const beforeSuccessfulPrint = await request('/api/shop/earnings', { token: shopToken });
  assert(
    beforeSuccessfulPrint.data.earnings?.amountDuePaise === 0
      && !beforeSuccessfulPrint.data.earnings.entries.some((entry) => entry.jobId === jobId),
    'a failed spool attempt creates no commission receivable',
  );
  const retried = await request(`/api/shop/jobs/${jobId}/retry-print`, { method: 'POST', token: shopToken, body: {} });
  assert(retried.status === 200, 'shop retried without asking the student for another OTP');

  await waitFor('successful retry awaiting manual finishing', async () => {
    const result = await request(`/api/jobs/${jobId}`, { token: studentToken });
    return result.data.job?.status === 'finishing';
  });
  assert(true, 'simulator completed printing without falsely marking a bound job ready');
  const printedPath = path.join(outputDir, `${jobId}.pdf`);
  const printed = await readFile(printedPath);
  assert(printed.subarray(0, 4).toString() === '%PDF', 'simulated spool output is a valid PDF');
  const printedPdf = await PDFDocument.load(printed);
  assert(printedPdf.getPageCount() === 2, 'spooled PDF contains only the student-selected page range');
  const printOptions = JSON.parse(await readFile(path.join(outputDir, `${jobId}.print-options.json`), 'utf8'));
  assert(
    printOptions.copies === 2
      && printOptions.color === true
      && printOptions.duplex === true
      && printOptions.paperSize === 'A4'
      && printOptions.bin === 'Tray 1',
    'simulator receives copies, colour, duplex, physical paper size and tray automatically',
  );
  const finished = await request(`/api/shop/jobs/${jobId}/finishing-complete`, { method: 'POST', token: shopToken });
  assert(finished.status === 200 && finished.data.job?.status === 'ready_for_pickup', 'staff confirms manual binding before student pickup notification');

  const earned = await waitFor('completed-print commission receivable', async () => {
    const result = await request('/api/shop/earnings', { token: shopToken });
    return result.data.earnings?.entries?.some((entry) => entry.jobId === jobId && entry.type === 'print_commission') ? result : null;
  });
  assert(
    earned.status === 200
      && earned.data.earnings?.amountDuePaise === 1000
      && earned.data.earnings?.entries?.filter((entry) => entry.jobId === jobId && entry.type === 'print_commission').length === 1
      && earned.data.earnings.entries.find((entry) => entry.jobId === jobId && entry.type === 'print_commission').amountPaise === 1000,
    'successful physical print posts one ₹10 PrintQs receivable',
  );

  const handedOver = await request(`/api/shop/jobs/${jobId}/handover`, { method: 'POST', token: shopToken });
  assert(handedOver.status === 200, 'shop marked the order collected');
  const completed = await request(`/api/jobs/${jobId}`, { token: studentToken });
  assert(completed.data.job.status === 'completed', 'student history shows a completed order');
  assert(!('priceBreakdown' in completed.data.job), 'student order API keeps the private pricing split hidden');

  console.log('\nShop UPI counter payment and accounting journey');
  const upiSpecs = { copies: 2, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: '1' };
  const retiredPaymentSelector = await request('/api/jobs', {
    method: 'POST',
    token: studentToken,
    body: { fileId, specs: upiSpecs, mode: 'instant', paymentMethod: 'online' },
  });
  assert(retiredPaymentSelector.status === 400, 'retired student payment selectors are rejected');
  const upiJobId = await createPayAtShop(studentToken, fileId, upiSpecs);
  const upiPrepared = await waitFor('prepared shop UPI order', async () => {
    const result = await request(`/api/jobs/${upiJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival' ? result.data.job : null;
  });
  assert(
    upiPrepared.paymentStatus === 'counter_due' && upiPrepared.position === null && upiPrepared.otpCode === null,
    'unpaid shop UPI order stays outside the physical line with its code hidden',
  );
  const upiCheckIn = await request(`/api/jobs/${upiJobId}/check-in`, {
    method: 'POST',
    token: studentToken,
    body: arrivalProof(),
  });
  assert(upiCheckIn.status === 200, 'shop UPI order joins only after arrival check-in');
  const upiLive = await request(`/api/jobs/${upiJobId}`, { token: studentToken });
  const upiCode = upiLive.data.job.otpCode;
  assert(/^\d{6}$/.test(upiCode ?? ''), 'shop UPI order code unlocks automatically near the front');
  const upiReleasePrompt = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: upiCode },
  });
  assert(
    upiReleasePrompt.status === 200
      && upiReleasePrompt.data.requiresPaymentConfirmation === true
      && upiReleasePrompt.data.counterPaymentAmountPaise === upiLive.data.job.totalPaise,
    'code lookup asks staff to verify the exact shop UPI receipt amount',
  );
  const stillUnpaid = await request(`/api/jobs/${upiJobId}`, { token: studentToken });
  assert(
    stillUnpaid.data.job.paymentStatus === 'counter_due' && stillUnpaid.data.job.status === 'queued',
    'looking up the code alone cannot mark shop UPI received or dispatch the document',
  );
  const upiReleased = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: {
      otp: upiCode,
      paymentConfirmation: { method: 'shop_upi', reference: 'merchant-app-verified-e2e' },
      ...(upiReleasePrompt.data.selectedPrinterId ? { printerId: upiReleasePrompt.data.selectedPrinterId } : {}),
    },
  });
  assert(upiReleased.status === 200 && upiReleased.data.ok, 'staff shop UPI confirmation releases the print');
  await waitFor('shop UPI print simulated jam', async () => {
    const result = await request(`/api/jobs/${upiJobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  const upiRetry = await request(`/api/shop/jobs/${upiJobId}/retry-print`, { method: 'POST', token: shopToken, body: {} });
  assert(upiRetry.status === 200, 'shop UPI print retains the hardware-failure recovery');
  await waitFor('shop UPI print completion', async () => {
    const result = await request(`/api/jobs/${upiJobId}`, { token: studentToken });
    return result.data.job?.status === 'ready_for_pickup';
  });
  const upiCommission = await waitFor('cash and shop UPI commission ledger', async () => {
    const result = await request('/api/shop/earnings', { token: shopToken });
    return result.data.earnings?.entries?.some((entry) => entry.jobId === upiJobId && entry.type === 'print_commission') ? result : null;
  });
  const expectedUpiCommissionPaise = upiLive.data.job.totalPaise - 400;
  assert(
    upiCommission.data.earnings.amountDuePaise === 1000 + expectedUpiCommissionPaise
      && upiCommission.data.earnings.entries.filter((entry) => entry.jobId === upiJobId && entry.type === 'print_commission').length === 1
      && upiCommission.data.earnings.entries.some((entry) => entry.jobId === upiJobId && entry.amountPaise === expectedUpiCommissionPaise),
    'cash and shop UPI both create one post-print commission receivable',
  );
  await request(`/api/shop/jobs/${upiJobId}/handover`, { method: 'POST', token: shopToken });

  const supportRefund = await request(`/api/admin/jobs/${jobId}/confirm-counter-refund`, {
    method: 'POST', token: adminToken,
    body: { studentConfirmed: true, method: 'cash', reason: 'E2E support verified the student and full cash return' },
  });
  assert(supportRefund.status === 200 && supportRefund.data.job?.paymentStatus === 'refunded', 'support records the completed-job refund after student confirmation');
  const duplicateSupportRefund = await request(`/api/admin/jobs/${jobId}/confirm-counter-refund`, {
    method: 'POST', token: adminToken,
    body: { studentConfirmed: true, method: 'cash', reason: 'Duplicate E2E refund must not create another credit' },
  });
  assert(duplicateSupportRefund.status === 409, 'completed-job refund cannot be credited twice');
  const afterSupportRefund = await request('/api/shop/earnings', { token: shopToken });
  assert(
    afterSupportRefund.data.earnings.amountDuePaise === expectedUpiCommissionPaise
      && afterSupportRefund.data.earnings.entries.filter((entry) => entry.jobId === jobId && entry.type === 'refund_credit').length === 1
      && afterSupportRefund.data.earnings.entries.some((entry) => entry.jobId === jobId && entry.type === 'refund_credit' && entry.amountPaise === -1000),
    'support refund posts one reversing credit with zero unexplained paise',
  );

  const returnJobId = await createPayAtShop(studentToken, fileId, upiSpecs);
  await waitFor('counter-return order prepared', async () => {
    const result = await request(`/api/jobs/${returnJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival';
  });
  await request(`/api/jobs/${returnJobId}/check-in`, { method: 'POST', token: studentToken, body: arrivalProof() });
  const returnLive = await request(`/api/jobs/${returnJobId}`, { token: studentToken });
  const returnPrompt = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: returnLive.data.job.otpCode },
  });
  await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: {
      otp: returnLive.data.job.otpCode,
      paymentConfirmation: { method: 'cash' },
      ...(returnPrompt.data.selectedPrinterId ? { printerId: returnPrompt.data.selectedPrinterId } : {}),
    },
  });
  await waitFor('counter-return simulated failure', async () => {
    const result = await request(`/api/jobs/${returnJobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  const counterReturned = await request(`/api/shop/jobs/${returnJobId}/counter-payment-returned`, { method: 'POST', token: shopToken, body: {} });
  assert(
    counterReturned.status === 200
      && counterReturned.data.job?.status === 'cancelled'
      && counterReturned.data.job?.paymentStatus === 'refunded',
    'staff closes a failed print after recording the full counter payment return',
  );
  const afterCounterReturn = await request('/api/shop/earnings', { token: shopToken });
  assert(
    !afterCounterReturn.data.earnings.entries.some((entry) => entry.jobId === returnJobId),
    'unprinted refunded job creates no PrintQs commission',
  );

  console.log('\nLate arrival, skip-safe counter lookup and refund journey');
  const queueFileId = await upload(studentToken, shopSlug, 1, 'arrival-model-test.pdf');
  const missedJobId = await createPayAtShop(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  const waitingJobId = await createPayAtShop(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  await waitFor('first prepared arrival order', async () => {
    const result = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival' ? result.data.job : null;
  });
  await request(`/api/jobs/${missedJobId}/check-in`, { method: 'POST', token: studentToken, body: arrivalProof() });
  const duplicateCheckIn = await request(`/api/jobs/${missedJobId}/check-in`, { method: 'POST', token: studentToken, body: arrivalProof() });
  assert(duplicateCheckIn.status === 200 && duplicateCheckIn.data.job?.status === 'queued', 'duplicate check-in is idempotent');
  await request(`/api/jobs/${waitingJobId}/check-in`, { method: 'POST', token: studentToken, body: arrivalProof() });
  const beforeSkipA = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
  const beforeSkipB = await request(`/api/jobs/${waitingJobId}`, { token: studentToken });
  assert(beforeSkipA.data.job.position === 1 && beforeSkipB.data.job.position === 2, 'arrivals receive one unambiguous shop-wide order');

  const skipped = await request(`/api/shop/jobs/${missedJobId}/no-show`, { method: 'POST', token: shopToken });
  assert(skipped.status === 200 && skipped.data.job?.status === 'awaiting_arrival', 'shop removes an absent student without cancelling the prepared order');
  const afterSkipA = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
  const afterSkipB = await request(`/api/jobs/${waitingJobId}`, { token: studentToken });
  assert(afterSkipA.data.job.position === null && afterSkipA.data.job.otpCode === beforeSkipA.data.job.otpCode, 'skipped order keeps its stable counter code outside the line');
  assert(afterSkipB.data.job.position === 1, 'remaining physical line closes the gap immediately');

  const outOfOrderRelease = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: beforeSkipA.data.job.otpCode },
  });
  assert(
    outOfOrderRelease.status === 200
      && outOfOrderRelease.data.requiresQueueOverride === true
      && outOfOrderRelease.data.position === null,
    'skipped-order release requires a visible out-of-order warning',
  );
  const overridePaymentPrompt = await request('/api/shop/release', {
    method: 'POST', token: shopToken,
    body: { otp: beforeSkipA.data.job.otpCode, overrideQueue: true },
  });
  assert(overridePaymentPrompt.status === 200 && overridePaymentPrompt.data.requiresPaymentConfirmation, 'queue override still requires attended payment confirmation');
  const overriddenRelease = await request('/api/shop/release', {
    method: 'POST', token: shopToken,
    body: {
      otp: beforeSkipA.data.job.otpCode,
      overrideQueue: true,
      paymentConfirmation: { method: 'cash' },
      ...(overridePaymentPrompt.data.selectedPrinterId ? { printerId: overridePaymentPrompt.data.selectedPrinterId } : {}),
    },
  });
  assert(overriddenRelease.status === 200 && overriddenRelease.data.ok, 'staff overrides and pays a skipped order without blocking the live line');
  await waitFor('second simulated first-attempt failure', async () => {
    const result = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  const secondRetry = await request(`/api/shop/jobs/${missedJobId}/retry-print`, { method: 'POST', token: shopToken, body: {} });
  assert(secondRetry.status === 200, 'out-of-order print also recovers from a simulated jam');
  await waitFor('out-of-order print completion', async () => {
    const result = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
    return result.data.job?.status === 'ready_for_pickup';
  });
  await request(`/api/shop/jobs/${missedJobId}/handover`, { method: 'POST', token: shopToken });

  const cancelled = await request(`/api/jobs/${waitingJobId}/cancel`, { method: 'POST', token: studentToken });
  assert(cancelled.status === 200, 'student can cancel an unpaid checked-in order before release');
  const duplicateCancel = await request(`/api/jobs/${waitingJobId}/cancel`, { method: 'POST', token: studentToken });
  assert(duplicateCancel.status === 409, 'duplicate cancellation cannot trigger a second refund');
  const unpaidCancelled = await request(`/api/jobs/${waitingJobId}`, { token: studentToken });
  assert(unpaidCancelled.data.job.paymentStatus === 'failed', 'unpaid cancellation does not invent a refund');
  const afterUnpaidCancel = await request('/api/shop/earnings', { token: shopToken });
  assert(!afterUnpaidCancel.data.earnings.entries.some((entry) => entry.jobId === waitingJobId), 'unprinted cancellation creates no commission');

  const remoteCancelJobId = await createPayAtShop(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  await waitFor('prepared cancellation order', async () => {
    const result = await request(`/api/jobs/${remoteCancelJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival';
  });
  const remoteCancelled = await request(`/api/jobs/${remoteCancelJobId}/cancel`, { method: 'POST', token: studentToken });
  assert(remoteCancelled.status === 200, 'remote prepared order can be cancelled before arrival');

  console.log('\nShop closing and existing-order protection');
  const closingJobId = await createPayAtShop(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  await waitFor('existing prepared order before pause', async () => {
    const result = await request(`/api/jobs/${closingJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival' ? result.data.job : null;
  });
  const paused = await request('/api/shop/availability', {
    method: 'PATCH',
    token: shopToken,
    body: { acceptingOrders: false },
  });
  assert(paused.status === 200 && paused.data.shop?.acceptingOrders === false, 'staff paused new orders');
  const closedStorefront = await request(`/api/public/shops/${shopSlug}`);
  assert(closedStorefront.data.shop?.open === false, 'paused storefront closes to new purchases');
  const honoredCheckIn = await request(`/api/jobs/${closingJobId}/check-in`, {
    method: 'POST',
    token: studentToken,
    body: arrivalProof(),
  });
  assert(honoredCheckIn.status === 200 && honoredCheckIn.data.job?.status === 'queued', 'existing prepared order can still check in after new sales pause');
  const closingLive = await request(`/api/jobs/${closingJobId}`, { token: studentToken });
  const blockedQuote = await request('/api/jobs/quote', {
    method: 'POST',
    token: studentToken,
    body: { fileId: queueFileId, specs: { ...specs, copies: 1, color: false, binding: null, pageRange: null } },
  });
  assert(blockedQuote.status === 409, 'paused shop cannot start a new checkout');
  const honoredPrompt = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: closingLive.data.job.otpCode },
  });
  assert(honoredPrompt.status === 200 && honoredPrompt.data.requiresPaymentConfirmation, 'paused shop still prompts for payment on an existing order');
  const honoredRelease = await request('/api/shop/release', {
    method: 'POST', token: shopToken,
    body: {
      otp: closingLive.data.job.otpCode,
      paymentConfirmation: { method: 'cash' },
      ...(honoredPrompt.data.selectedPrinterId ? { printerId: honoredPrompt.data.selectedPrinterId } : {}),
    },
  });
  assert(honoredRelease.status === 200 && honoredRelease.data.ok, 'existing counter code prints after staff payment confirmation while sales are paused');
  await waitFor('paused-storefront simulated jam', async () => {
    const result = await request(`/api/jobs/${closingJobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  const closingRetry = await request(`/api/shop/jobs/${closingJobId}/retry-print`, { method: 'POST', token: shopToken, body: {} });
  assert(closingRetry.status === 200, 'paused-storefront print can recover from hardware failure');
  await waitFor('paused-storefront print completion', async () => {
    const result = await request(`/api/jobs/${closingJobId}`, { token: studentToken });
    return result.data.job?.status === 'ready_for_pickup';
  });
  assert(true, 'existing counter-paid order completed while new sales stayed paused');
  await request(`/api/shop/jobs/${closingJobId}/handover`, { method: 'POST', token: shopToken });
  const reopened = await request('/api/shop/availability', {
    method: 'PATCH',
    token: shopToken,
    body: { acceptingOrders: true },
  });
  assert(reopened.status === 200 && reopened.data.shop?.acceptingOrders === true, 'staff reopened new orders');
  const openStorefrontAgain = await request(`/api/public/shops/${shopSlug}`);
  assert(openStorefrontAgain.data.shop?.open === true, 'reopened storefront is visible to students again');

  console.log(`\nE2E SIMULATOR PASSED — ${assertions} assertions ✓`);
}

try {
  await main();
} catch (error) {
  console.error(`\nE2E SIMULATOR FAILED: ${error instanceof Error ? error.message : error}`);
  if (apiOutput) console.error(`\nAPI tail:\n${apiOutput.slice(-3000)}`);
  if (agentOutput) console.error(`\nAgent tail:\n${agentOutput.slice(-3000)}`);
  process.exitCode = 1;
} finally {
  for (const child of processes.reverse()) child.kill();
  await sleep(300);
  if (!remote) {
  const cleanupRedis = new Redis(isolatedRedisUrl, { maxRetriesPerRequest: 1 });
  await cleanupRedis.flushdb().catch(() => undefined);
  await cleanupRedis.quit().catch(() => undefined);
  await rm(tempDir, { recursive: true, force: true });
  } else {
    console.log(`Remote test print artifacts retained at ${outputDir}`);
  }
}
