// Performs the core tasks in a real browser and measures them with the Ledger.
// Usage: UX_SCRATCH=... node journeys.mjs <out.json> <before|after> [taskFilter]
// Local stack only (web :5173, api :4000, fake counter PC running for shop A).
import { chromium } from 'playwright';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { Ledger } from './ledger.mjs';
import {
  api, must, waitFor, loadState, saveState, createOrder, checkIn, studentJob, WEB, SHOP_POINT, SCRATCH, makePdf, sleep,
} from './lib.mjs';

const OUT = process.argv[2];
const UI = process.argv[3] ?? 'before';
const FILTER = process.argv[4] ? new RegExp(process.argv[4]) : null;
const state = loadState();
const S = state.students;
const A = state.shopA;
const results = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
const browser = await chromium.launch();
const pdfPath = `${SCRATCH}/upload-sample.pdf`;
writeFileSync(pdfPath, await makePdf(6, 'Lab-report'));

async function context(viewport, auth, extra = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, ...extra });
  await ctx.addInitScript(([a]) => {
    localStorage.setItem('printq:installPromptDismissed', '1');
    if (a) { localStorage.setItem(`printq:${a[0]}:token`, a[1]); if (a[2]) localStorage.setItem('printq:shop:role', a[2]); }
  }, [auth]);
  return ctx;
}

// ---- queue helpers -----------------------------------------------------------
async function clearLine() {
  const q = await api('/api/shop/queue', { token: A.token });
  for (const j of q.data.jobs ?? []) {
    if (['queued', 'notified'].includes(j.status)) await api(`/api/shop/jobs/${j.id}/no-show`, { method: 'POST', token: A.token });
  }
}
async function finishInFlight() {
  // leave no printing/pickup rows from earlier runs (keeps the screen comparable)
  const q = await api('/api/shop/queue', { token: A.token });
  for (const j of q.data.jobs ?? []) {
    if (j.status === 'printing' && j.spoolAcceptedAt) await api(`/api/shop/jobs/${j.id}/confirm-print-completion`, { method: 'POST', token: A.token });
  }
  const q2 = await api('/api/shop/queue', { token: A.token });
  for (const j of q2.data.jobs ?? []) {
    if (j.status === 'ready_for_pickup') await api(`/api/shop/jobs/${j.id}/handover`, { method: 'POST', token: A.token });
    if (j.status === 'finishing') {
      await api(`/api/shop/jobs/${j.id}/finishing-complete`, { method: 'POST', token: A.token });
      await api(`/api/shop/jobs/${j.id}/handover`, { method: 'POST', token: A.token });
    }
  }
}
const rota = ['aarav', 'priya', 'rohan', 'sneha', 'kabir', 'ananya'];
async function lineUp(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const who = rota[i % rota.length];
    const { jobId } = await createOrder(S[who].token, A.slug, { pages: 3 + i, name: `Rush-${i + 1}.pdf`, specs: { duplex: i % 2 === 0 } });
    await checkIn(S[who].token, jobId);
    out.push({ who, jobId });
  }
  return out;
}
async function codeWhenRevealed(who, jobId) {
  return waitFor('code revealed', async () => (await studentJob(S[who].token, jobId))?.otpCode ?? null, 30_000);
}

// ---- tasks -------------------------------------------------------------------
const tasks = {};

/** (b) one student at the counter, code known, pay at shop, auto-assign on. */
tasks.counterRelease = async (viewport = { width: 1366, height: 768 }, label = 'b-counter-release') => {
  await clearLine(); await finishInFlight();
  const [t] = await lineUp(1);
  const code = await codeWhenRevealed(t.who, t.jobId);
  const ctx = await context(viewport, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  if (UI === 'before') {
    const input = page.getByLabel("Student's counter code");
    await L.type(input, code, 'counter code');
    await L.press('Enter');
    await L.click(page.getByRole('button', { name: 'Cash received & print' }), 'Cash received & print');
    await page.getByText('Sent to printer').waitFor({ timeout: 15_000 });
  } else {
    const input = page.getByRole('textbox', { name: 'Counter code' });
    await L.type(input, code, 'counter code');
    await L.click(page.getByRole('button', { name: /Cash received & print/ }), 'Cash received & print');
    await page.getByRole('status').filter({ hasText: /Sent to/ }).first().waitFor({ timeout: 15_000 });
  }
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  const after = await page.evaluate(() => ({ focusedTag: document.activeElement?.tagName, focusedLabel: document.activeElement?.getAttribute('aria-label') }));
  s.focusAfterRelease = after;
  await ctx.close();
  return s;
};

/** (b2) the same print came out: confirm printed, hand over. */
tasks.counterFinish = async (viewport = { width: 1366, height: 768 }, label = 'b2-printed-and-handover') => {
  const q = await api('/api/shop/queue', { token: A.token });
  const printing = await waitFor('a spooled job', async () => {
    const r = await api('/api/shop/queue', { token: A.token });
    return r.data.jobs?.find((j) => j.status === 'printing' && j.spoolAcceptedAt);
  }, 30_000);
  void q;
  const ctx = await context(viewport, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  const name = printing.file.originalName;
  if (UI === 'before') {
    const row = page.locator('tr', { hasText: name });
    await L.click(row.getByRole('button', { name: 'Printed successfully' }), 'Printed successfully');
    await L.click(page.locator('tr', { hasText: name }).getByRole('button', { name: 'Handed over' }), 'Handed over');
  } else {
    const card = page.locator('[data-job-card]', { hasText: name });
    await L.click(card.getByRole('button', { name: /Printed OK/ }), 'Printed OK & handed over');
  }
  await waitFor('completed', async () => {
    const r = await api('/api/shop/history', { token: A.token });
    return (r.data.jobs ?? []).some((j) => j.id === printing.id && j.status === 'completed');
  }, 15_000).catch(() => null);
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  return s;
};

/** (c) busy moment: 10 students, each released, printed and handed over, on one screen session. */
tasks.counterRush = async () => {
  await clearLine(); await finishInFlight();
  const line = await lineUp(10);
  const viewport = { width: 1366, height: 768 };
  const ctx = await context(viewport, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, 'c-counter-rush-10');
  let idx = 0;
  for (const t of line) {
    idx += 1;
    const code = await codeWhenRevealed(t.who, t.jobId);
    page.once('pageerror', () => undefined);
    L.note('student ' + idx);
    if (UI === 'before') {
      const input = page.getByLabel("Student's counter code");
      await L.type(input, code, 'counter code');
      await L.press('Enter');
      try { await L.click(page.getByRole('button', { name: 'Cash received & print' }), 'Cash received & print'); }
      catch (e) { await page.screenshot({ path: SCRATCH + '/rush-fail.png', fullPage: true }); throw new Error('student ' + idx + ': ' + e.message); }
      await page.getByText('Sent to printer').waitFor({ timeout: 15_000 });
    } else {
      const input = page.getByRole('textbox', { name: 'Counter code' });
      await L.type(input, code, 'counter code');
      try { await L.click(page.getByRole('button', { name: /Cash received & print/ }), 'Cash received & print'); }
      catch (e) { await page.screenshot({ path: SCRATCH + '/rush-fail-after.png', fullPage: true }); throw new Error('student ' + idx + ': ' + e.message); }
      await page.getByRole('status').filter({ hasText: /Sent to/ }).first().waitFor({ timeout: 15_000 });
    }
    const job = await waitFor('spooled', async () => {
      const r = await api('/api/shop/queue', { token: A.token });
      return r.data.jobs?.find((j) => j.id === t.jobId && j.status === 'printing' && j.spoolAcceptedAt);
    }, 30_000);
    const name = job.file.originalName;
    if (UI === 'before') {
      await L.click(page.locator('tr', { hasText: name }).getByRole('button', { name: 'Printed successfully' }), 'Printed successfully');
      await L.click(page.locator('tr', { hasText: name }).getByRole('button', { name: 'Handed over' }), 'Handed over');
    } else {
      await L.click(page.locator('[data-job-card]', { hasText: name }).getByRole('button', { name: /Printed OK/ }), 'Printed OK & handed over');
    }
    await waitFor('row gone', async () => {
      const r = await api('/api/shop/queue', { token: A.token });
      return !(r.data.jobs ?? []).some((j) => j.id === t.jobId);
    }, 15_000);
  }
  const s = L.summary({ viewport: '1366x768', students: 10 });
  await ctx.close();
  return s;
};

let phoneSeq = Number(state.nextPhone ?? 9876500100);
/** (d) first-time student: landing to order placed (file selection excluded from time). */
tasks.firstOrder = async (viewport = { width: 390, height: 844 }, label = 'd-first-order') => {
  const phone = String(phoneSeq++); state.nextPhone = phoneSeq; saveState(state);
  const ctx = await context(viewport, null, { hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  if (UI === 'before') await L.tap(page.getByRole('link', { name: /Start a print/ }), 'Start a print');
  else await L.tap(page.getByRole('link', { name: /Start a print/ }).first(), 'Start a print');
  await L.type(page.getByLabel('Mobile number'), phone, 'mobile number');
  await L.tap(page.getByRole('button', { name: /Send secure code|Send code/ }), 'Send code');
  const code = await waitFor('otp', async () => {
    const log = readFileSync(`${SCRATCH}/api.log`, 'utf8');
    const m = [...log.matchAll(/"phone":"([^"]+)","loginCode":"(\d{6})"/g)].reverse().find((x) => x[1].endsWith(phone));
    return m?.[2] ?? null;
  });
  await L.type(page.getByLabel('Six-digit verification code'), code, 'login code');
  if (await page.getByRole('button', { name: 'Verify and continue' }).isVisible().catch(() => false)) {
    await L.tap(page.getByRole('button', { name: 'Verify and continue' }), 'Verify and continue');
  }
  await L.type(page.getByLabel('Full name'), 'Isha Kulkarni', 'full name');
  await L.tap(page.getByRole('button', { name: /Finish setup|Continue/ }), 'Finish setup');
  await page.waitForURL(/\/home|\/shops/, { timeout: 15_000 });
  if (page.url().includes('/home')) await L.tap(page.getByRole('button', { name: /New print/ }).first(), 'New print');
  await page.waitForURL(/\/shops/, { timeout: 15_000 });
  await L.tap(page.getByRole('link', { name: new RegExp(A.name.replace(/[&]/g, '.')) }).first(), 'choose shop');
  await page.waitForURL(new RegExp(`/s/${A.slug}`));
  await L.pickFile(page.getByRole('button', { name: /Choose files|Choose a file|Upload/ }).first(), pdfPath);
  await page.waitForURL(/\/file\//, { timeout: 30_000 });
  const placeBtn = page.getByRole('button', { name: /Prepare order|Place order/ }).first();
  await waitFor('total', async () => (await placeBtn.isEnabled().catch(() => false)) ? true : null, 20_000);
  await L.tap(placeBtn, 'Place order');
  await page.waitForURL(/\/jobs\//, { timeout: 20_000 });
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  return s;
};

/** (e) returning student, same shop: Home to order placed. */
tasks.repeatOrder = async (viewport = { width: 390, height: 844 }, label = 'e-repeat-order') => {
  const ctx = await context(viewport, ['student', S.rohan.token], { hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/home`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  await L.tap(page.getByRole('button', { name: /New print/ }).first(), 'New print');
  await page.waitForURL(new RegExp(`/s/${A.slug}`), { timeout: 15_000 });
  await L.pickFile(page.getByRole('button', { name: /Choose files|Choose a file|Upload/ }).first(), pdfPath);
  await page.waitForURL(/\/file\//, { timeout: 30_000 });
  const placeBtn = page.getByRole('button', { name: /Prepare order|Place order/ }).first();
  await waitFor('total', async () => (await placeBtn.isEnabled().catch(() => false)) ? true : null, 20_000);
  await L.tap(placeBtn, 'Place order');
  await page.waitForURL(/\/jobs\//, { timeout: 20_000 });
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  return s;
};

/** (f) student at the shop door: check in, read the counter code. */
tasks.checkInCode = async (viewport = { width: 390, height: 844 }, label = 'f-check-in-read-code') => {
  await clearLine();
  const { jobId } = await createOrder(S.sneha.token, A.slug, { pages: 2, name: 'Door-test.pdf' });
  const ctx = await context(viewport, ['student', S.sneha.token], { hasTouch: true, isMobile: true, permissions: ['geolocation'], geolocation: { ...SHOP_POINT, accuracy: 10 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/jobs/${jobId}`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  await L.tap(page.getByRole('button', { name: /I.m at the shop|I.m here/ }).first(), "I'm at the shop");
  const confirm = page.getByRole('button', { name: /Yes, join the line|Join the line/ });
  if (await confirm.isVisible().catch(() => false)) await L.tap(confirm, 'Yes, join the line');
  const codeEl = page.locator('.otp-band, [data-counter-code]').first();
  await codeEl.waitFor({ timeout: 20_000 });
  const box = await codeEl.boundingBox();
  const fontPx = await codeEl.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}`, codeVisibleWithoutScroll: box ? box.y + box.height <= viewport.height : false, codeTopPx: box ? Math.round(box.y) : null, codeFontPx: fontPx });
  await ctx.close();
  return s;
};

/** (g) owner changes the A4 black & white price. */
tasks.changePrice = async (viewport = { width: 1366, height: 768 }, label = 'g-change-price') => {
  const ctx = await context(viewport, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  if (UI === 'before') {
    await L.click(page.getByRole('link', { name: 'Settings', exact: true }), 'Settings');
    const a4bw = page.locator('.opt-row.priced-row').first().locator('input').nth(1);
    await L.fill(a4bw, '2.50', 'A4 B/W price');
    await L.click(page.getByRole('button', { name: 'Save all changes' }), 'Save all changes');
  } else {
    await L.click(page.getByRole('link', { name: 'Shop', exact: true }), 'Shop');
    await L.click(page.getByRole('link', { name: 'Prices', exact: true }), 'Prices');
    const a4bw = page.getByLabel(/A4.*black/i).first();
    await L.fill(a4bw, '2.50', 'A4 B/W price');
    await L.click(page.getByRole('button', { name: /Save prices/ }), 'Save prices');
  }
  await page.getByText(/saved|Saved/).first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  // put the price back so later screenshots show the fixture's round prices
  const me = (await api('/api/shop/me', { token: A.token })).data.shop;
  const po = { ...me.printOptions, papers: me.printOptions.papers.map((p) => (p.id === 'A4' ? { ...p, bwPaise: 200 } : p)) };
  await api('/api/shop/me', { method: 'PATCH', token: A.token, body: { printOptions: po, expectedPrintOptionsVersion: me.printOptionsVersion } });
  return s;
};

/** (h) owner adds a detected printer (shop C, practice simulator). */
tasks.addPrinter = async (viewport = { width: 1366, height: 768 }, label = 'h-add-printer') => {
  const C = state.shopC;
  // remove an earlier run's printer so the detected one is offered again
  const list = await api('/api/shop/printers', { token: C.token });
  for (const p of list.data.printers ?? []) await api(`/api/shop/printers/${p.id}`, { method: 'DELETE', token: C.token });
  const ctx = await context(viewport, ['shop', C.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  if (UI === 'before') {
    await L.click(page.getByRole('link', { name: 'Printers', exact: true }), 'Printers');
  } else {
    await L.click(page.getByRole('link', { name: 'Shop', exact: true }), 'Shop');
    await L.click(page.getByRole('link', { name: 'Printers', exact: true }), 'Printers');
  }
  await L.click(page.getByRole('button', { name: /Add & configure|Add printer/ }).first(), 'Add printer');
  await L.click(page.getByRole('button', { name: /Yes, colour/ }).first(), 'Yes, colour');
  await waitFor('printer row', async () => ((await api('/api/shop/printers', { token: C.token })).data.printers ?? []).length > 0 || null, 10_000);
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  return s;
};

/** (i) admin hides then re-publishes a shop. */
tasks.adminReview = async (viewport = { width: 1366, height: 768 }, label = 'i-admin-unpublish-publish') => {
  const cred = JSON.parse(readFileSync(`${SCRATCH}/admin-cred.json`, 'utf8'));
  const token = (await api('/api/admin/auth/login', { method: 'POST', body: cred })).data.token;
  const ctx = await context(viewport, ['admin', token]);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/admin`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  const row = page.locator('.admin-shop', { hasText: A.name }).first();
  await L.click(row.getByRole('button', { name: 'Unpublish' }), 'Unpublish');
  await L.type(page.getByLabel(/Why are you hiding/), 'Owner asked to pause', 'reason');
  await L.click(page.locator('.admin-shop', { hasText: A.name }).first().getByRole('button', { name: 'Unpublish' }).last(), 'confirm Unpublish');
  await page.waitForTimeout(800);
  const hidden = page.locator('button', { hasText: /^Hidden|Not live/ }).first();
  if (await hidden.isVisible().catch(() => false)) await L.click(hidden, 'Hidden tab');
  await L.click(page.locator('.admin-shop', { hasText: A.name }).first().getByRole('button', { name: /^Publish/ }), 'Publish');
  await waitFor('public again', async () => (await api(`/api/public/shops/${A.slug}`)).status === 200 || null, 15_000);
  const s = L.summary({ viewport: `${viewport.width}x${viewport.height}` });
  await ctx.close();
  return s;
};

/** (a) owner registers and goes live (web steps; the PC install happens in the desktop app and is simulated). */
tasks.registerGoLive = async (viewport = { width: 1366, height: 768 }, label = 'a-register-go-live') => {
  const { spawn } = await import('node:child_process');
  const seq = Date.now().toString(36);
  const ctx = await context(viewport, null, { permissions: ['geolocation'], geolocation: { latitude: SHOP_POINT.latitude + 0.02, longitude: SHOP_POINT.longitude, accuracy: 12 } });
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard/register`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, label);
  await L.type(page.getByLabel('Shop name'), 'Om Sai Xerox', 'shop name');
  await L.type(page.getByLabel('Shop address'), 'Shop 2, College Road', 'shop address');
  await L.type(page.getByLabel(/Owner name|Your name/), 'Suresh Patil', 'owner name');
  await L.type(page.getByLabel('Email'), `owner.${seq}@ux.printq.local`, 'email');
  await L.type(page.getByLabel('Password', { exact: true }), 'Counter-Desk-2026', 'password');
  await L.click(page.getByRole('button', { name: /Create shop/ }), 'Create shop & continue');
  await page.waitForURL(/\/dashboard\/setup/, { timeout: 20_000 });
  const token = await page.evaluate(() => localStorage.getItem('printq:shop:token'));
  const save = page.getByRole('button', { name: 'Save location' });
  await waitFor('pin placed', async () => (await save.isEnabled().catch(() => false)) || null, 20_000);
  await L.click(save, 'Save location');
  await waitFor('location saved', async () => (await api('/api/shop/setup-status', { token })).data.setup?.locationReady || null, 10_000);
  // --- outside the web app: install PrintQs Shop on the counter PC and sign in (simulated) ---
  L.note('PC install + sign-in happen in the desktop app (not measured)');
  const agent = await must('agent', api('/api/shop/agents', { method: 'POST', token, body: { machineLabel: 'Counter PC', connectedPrinterIds: [] } }));
  const pc = spawn(process.execPath, ['fake-counter-pc.mjs'], { env: { ...process.env, FAKE_AGENT_TOKEN: agent.token, FAKE_PRINTERS: '[{"name":"Canon LBP2900","paperSizes":["A4"]}]' }, stdio: 'ignore' });
  try {
    await waitFor('pc online', async () => ((await api('/api/shop/agents', { token })).data.agents ?? []).some((a) => a.status === 'online' && a.detectedPrinters?.length) || null, 20_000);
    await page.waitForTimeout(9000); // setup page polls every 8 s
    if (UI === 'before') {
      await L.click(page.getByRole('link', { name: /Add printer/ }).first(), 'Add printer (step 3)');
      await L.click(page.getByRole('button', { name: /Add & configure/ }).first(), 'Add & configure');
      await L.click(page.getByRole('button', { name: /No, black/ }).first(), 'No, black & white');
    } else {
      await L.click(page.getByRole('button', { name: /Add .*Canon|Add this printer|Add printer/ }).first(), 'Add printer');
      await L.click(page.getByRole('button', { name: /No, black/ }).first(), 'No, black & white');
    }
    const live = await waitFor('live', async () => ((await api('/api/shop/setup-status', { token })).data.setup?.visibility?.state === 'live') || null, 20_000).catch(() => false);
    const s = L.summary({ viewport: `${viewport.width}x${viewport.height}`, wentLive: Boolean(live) });
    await ctx.close();
    return s;
  } finally {
    pc.kill();
  }
};

/** (b-kbd) the counter release with the keyboard only (new UI): 6 digits, Tab, Enter. */
tasks.counterKeyboard = async () => {
  await clearLine(); await finishInFlight();
  const [t] = await lineUp(1);
  const code = await codeWhenRevealed(t.who, t.jobId);
  const ctx = await context({ width: 1366, height: 768 }, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const L = new Ledger(page, 'b-counter-release-keyboard');
  const input = page.getByRole('textbox', { name: 'Counter code' });
  await L.type(input, code, 'counter code');
  await page.locator('.order-card').waitFor({ timeout: 10_000 });
  await L.press('Tab');
  const focusedText = await page.evaluate(() => document.activeElement?.textContent ?? '');
  // a habitual Enter while the code box still has focus must not confirm money
  await L.press('Enter');
  await page.getByRole('status').filter({ hasText: /Sent to/ }).first().waitFor({ timeout: 15_000 });
  const backInCodeBox = await page.evaluate(() => document.activeElement?.id === 'counter-code');
  const s = L.summary({ viewport: '1366x768', tabLandsOn: focusedText, focusBackInCodeBox: backInCodeBox });
  await ctx.close();
  return s;
};

/** Enter pressed twice by habit in the code box never records a payment. */
tasks.counterDoubleEnter = async () => {
  await clearLine(); await finishInFlight();
  const [t] = await lineUp(1);
  const code = await codeWhenRevealed(t.who, t.jobId);
  const ctx = await context({ width: 1366, height: 768 }, ['shop', A.token, 'owner']);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  const input = page.getByRole('textbox', { name: 'Counter code' });
  await input.pressSequentially(code, { delay: 15 });
  await page.keyboard.press('Enter');
  await page.locator('.order-card').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  const job = await studentJob(S[t.who].token, t.jobId);
  await ctx.close();
  return { task: 'b-double-enter-safety', paymentStatusAfterTwoEnters: job.paymentStatus, statusAfterTwoEnters: job.status, ok: job.paymentStatus === 'counter_due' };
};

const plan = [
  ['b-counter-release-keyboard', () => (UI === 'after' ? tasks.counterKeyboard() : Promise.resolve({ task: 'n/a' }))],
  ['b-double-enter-safety', () => (UI === 'after' ? tasks.counterDoubleEnter() : Promise.resolve({ task: 'n/a' }))],
  ['a-register-go-live', () => tasks.registerGoLive()],
  ['b-counter-release', () => tasks.counterRelease()],
  ['b2-printed-and-handover', () => tasks.counterFinish()],
  ['b-counter-release-1280', () => tasks.counterRelease({ width: 1280, height: 720 }, 'b-counter-release-1280')],
  ['b2-printed-and-handover-1280', () => tasks.counterFinish({ width: 1280, height: 720 }, 'b2-printed-and-handover-1280')],
  ['b-counter-release-phone', () => tasks.counterRelease({ width: 390, height: 844 }, 'b-counter-release-phone')],
  ['b2-printed-and-handover-phone', () => tasks.counterFinish({ width: 390, height: 844 }, 'b2-printed-and-handover-phone')],
  ['c-counter-rush-10', () => tasks.counterRush()],
  ['d-first-order', () => tasks.firstOrder()],
  ['d-first-order-360', () => tasks.firstOrder({ width: 360, height: 640 }, 'd-first-order-360')],
  ['e-repeat-order', () => tasks.repeatOrder()],
  ['f-check-in-read-code', () => tasks.checkInCode()],
  ['g-change-price', () => tasks.changePrice()],
  ['h-add-printer', () => tasks.addPrinter()],
  ['i-admin-unpublish-publish', () => tasks.adminReview()],
];

for (const [name, run] of plan) {
  if (FILTER && !FILTER.test(name)) continue;
  try {
    const r = await run();
    results[name] = r;
    console.log(`${name}: clicks ${r.clicksOrTaps}, keys ${r.keystrokes}, fields ${r.fields}, scrolls ${r.scrolls}, dialogs ${r.dialogs}, KLM ${r.klmSeconds}s, wall ${r.scriptedWallSeconds}s`);
  } catch (e) {
    results[name] = { task: name, error: String(e).slice(0, 400) };
    console.log(`${name}: ERROR ${String(e).slice(0, 300)}`);
  }
  writeFileSync(OUT, JSON.stringify(results, null, 2));
  await sleep(300);
}
await browser.close();
