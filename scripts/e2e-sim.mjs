/**
 * Launch-grade E2E: boots the built API and the real PrintQ agent in simulator
 * mode, then proves onboarding -> upload -> payment -> queue -> OTP -> failed
 * print -> one-click retry -> pickup, plus cancellation/refund.
 *
 * Run after `npm run build`, or use `npm run test:launch`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import Redis from 'ioredis';
import { createInterface } from 'node:readline/promises';

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

async function createAndPay(token, fileId, specs) {
  const created = await request('/api/jobs', {
    method: 'POST',
    token,
    body: { fileId, specs, mode: 'instant' },
  });
  assert(created.status === 201 && created.data.job?.id, 'job created');
  const jobId = created.data.job.id;
  const paid = await request('/api/payments/mock/confirm', { method: 'POST', token, body: { jobId } });
  assert(paid.status === 200, 'mock payment confirmed');
  return jobId;
}

async function main() {
  const apiEntry = path.join(ROOT, 'apps', 'api', 'dist', 'server.js');
  const agentEntry = path.join(ROOT, 'apps', 'agent', 'dist', 'index.js');
  if ((!remote && !existsSync(apiEntry)) || !existsSync(agentEntry)) {
    throw new Error('Built API/agent not found. Run `npm run build` first.');
  }
  await mkdir(outputDir, { recursive: true });

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
    SHOP_PAYOUT_PROVIDER: 'mock',
    MIN_SHOP_PAYOUT_PAISE: '100',
    SMS_PROVIDER: 'console',
    EMAIL_PROVIDER: 'console',
    LOG_LEVEL: 'info',
    REDIS_URL: isolatedRedisUrl,
    STORAGE_LOCAL_DIR: storageDir,
  });
  }
  console.log(`Testing ${API}${remote ? ' (remote test deployment; no database/Redis resets)' : ''}`);
  await waitFor('API health', async () => fetch(`${API}/healthz`).then((response) => response.ok).catch(() => false));
  assert(true, 'built API is healthy');

  console.log('\nShop onboarding and simulated printer setup');
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
    body: { latitude: 28.6139, longitude: 77.209, checkInRadiusM: 150 },
  });
  assert(located.status === 200 && located.data.shop?.locationUpdatedAt, 'secure arrival zone configured');

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
  const setup = await request('/api/shop/setup-status', { token: shopToken });
  assert(setup.data.setup?.ready === true, 'setup checklist reports launch-ready');
  const publicShop = await request(`/api/public/shops/${shopSlug}`);
  assert(publicShop.data.shop?.open === true, 'student storefront opens only with a reachable agent');
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
  const jobId = await createAndPay(studentToken, fileId, specs);

  const prepared = await waitFor('prepared remote order', async () => {
    const result = await request(`/api/jobs/${jobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival' ? result.data.job : null;
  });
  assert(prepared.position === null, 'remote upload does not occupy the physical line');
  assert(prepared.otpCode === null, 'counter code stays hidden before physical check-in');
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
  const released = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: live.data.job.otpCode },
  });
  assert(released.status === 200 && released.data.ok, 'counter code dispatches the checked-in job');

  await waitFor('simulated first-attempt failure', async () => {
    const result = await request(`/api/jobs/${jobId}`, { token: studentToken });
    return result.data.job?.status === 'otp_verified' && result.data.job?.printError;
  });
  assert(agentOutput.includes('simulated printer jam on first attempt'), 'simulator exercised a printer-jam failure');
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

  const earned = await waitFor('shop earning credit', async () => {
    const result = await request('/api/shop/earnings', { token: shopToken });
    return result.data.earnings?.availablePaise === 4000 ? result : null;
  });
  assert(
    earned.status === 200
      && earned.data.earnings?.availablePaise === 4000
      && earned.data.earnings?.pendingPaise === 0
      && earned.data.earnings?.lifetimeEarnedPaise === 4000,
    'successful physical print credits exactly the shop-owned ₹40 base',
  );
  const payout = await request('/api/shop/earnings/payout', { method: 'POST', token: shopToken });
  assert(
    payout.status === 201 && payout.data.payout?.status === 'paid' && payout.data.payout?.amountPaise === 4000,
    'owner can request one aggregated simulated payout',
  );
  const afterPayout = await request('/api/shop/earnings', { token: shopToken });
  assert(
    afterPayout.data.earnings?.availablePaise === 0 && afterPayout.data.earnings?.lifetimeEarnedPaise === 4000,
    'payout reservation prevents double payment without erasing lifetime earnings',
  );

  const handedOver = await request(`/api/shop/jobs/${jobId}/handover`, { method: 'POST', token: shopToken });
  assert(handedOver.status === 200, 'shop marked the order collected');
  const completed = await request(`/api/jobs/${jobId}`, { token: studentToken });
  assert(completed.data.job.status === 'completed', 'student history shows a completed order');
  assert(!('priceBreakdown' in completed.data.job), 'student order API keeps the private pricing split hidden');

  console.log('\nLate arrival, skip-safe counter lookup and refund journey');
  const queueFileId = await upload(studentToken, shopSlug, 1, 'arrival-model-test.pdf');
  const missedJobId = await createAndPay(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  const waitingJobId = await createAndPay(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
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
  assert(skipped.status === 200 && skipped.data.job?.status === 'awaiting_arrival', 'shop removes an absent student without cancelling the paid order');
  const afterSkipA = await request(`/api/jobs/${missedJobId}`, { token: studentToken });
  const afterSkipB = await request(`/api/jobs/${waitingJobId}`, { token: studentToken });
  assert(afterSkipA.data.job.position === null && afterSkipA.data.job.otpCode === beforeSkipA.data.job.otpCode, 'skipped order keeps its stable counter code outside the line');
  assert(afterSkipB.data.job.position === 1, 'remaining physical line closes the gap immediately');

  const outOfOrderRelease = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: beforeSkipA.data.job.otpCode },
  });
  assert(outOfOrderRelease.status === 200 && outOfOrderRelease.data.ok, 'counter code prints a skipped order without rejoining or blocking anyone');
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
  assert(cancelled.status === 200, 'student can cancel a checked-in order before release');
  const duplicateCancel = await request(`/api/jobs/${waitingJobId}/cancel`, { method: 'POST', token: studentToken });
  assert(duplicateCancel.status === 409, 'duplicate cancellation cannot trigger a second refund');
  const refunded = await request(`/api/jobs/${waitingJobId}`, { token: studentToken });
  assert(refunded.data.job.paymentStatus === 'refunded', 'payment was refunded exactly once');

  const remoteCancelJobId = await createAndPay(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  await waitFor('prepared cancellation order', async () => {
    const result = await request(`/api/jobs/${remoteCancelJobId}`, { token: studentToken });
    return result.data.job?.status === 'awaiting_arrival';
  });
  const remoteCancelled = await request(`/api/jobs/${remoteCancelJobId}/cancel`, { method: 'POST', token: studentToken });
  assert(remoteCancelled.status === 200, 'remote prepared order can be cancelled before arrival');

  console.log('\nShop closing and existing-order protection');
  const closingJobId = await createAndPay(studentToken, queueFileId, { ...specs, copies: 1, color: false, binding: null, pageRange: null });
  await waitFor('existing paid order before pause', async () => {
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
  assert(honoredCheckIn.status === 200 && honoredCheckIn.data.job?.status === 'queued', 'already-paid order can still check in after new sales pause');
  const closingLive = await request(`/api/jobs/${closingJobId}`, { token: studentToken });
  const blockedQuote = await request('/api/jobs/quote', {
    method: 'POST',
    token: studentToken,
    body: { fileId: queueFileId, specs: { ...specs, copies: 1, color: false, binding: null, pageRange: null } },
  });
  assert(blockedQuote.status === 409, 'paused shop cannot start a new checkout');
  const honoredRelease = await request('/api/shop/release', {
    method: 'POST',
    token: shopToken,
    body: { otp: closingLive.data.job.otpCode },
  });
  assert(honoredRelease.status === 200 && honoredRelease.data.ok, 'existing counter code still prints while new sales are paused');
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
  assert(true, 'existing paid order completed while new sales stayed paused');
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
