// One full pass through the product with brand-new accounts, driven through the UI, local stack only.
// Owner registers -> places the pin -> counter PC (stand-in) connects with the PrintQ Simulator -> owner adds it
// -> shop goes live -> new student signs up, orders, checks in, gets the code -> counter types it, takes cash,
// sends to print -> staff confirm "Printed OK · hand over" -> student sees it collected -> History and Earnings.
// Usage: UX_SCRATCH=... node e2e-fresh.mjs <outDir> phone|desktop
// The desktop app install/sign-in is outside the web app: the harness creates the PC login through the API and
// runs fake-counter-pc.mjs in its place (development treats the simulator as a printer that can finish orders).
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { api, must, waitFor, makePdf, loadState, saveState, WEB, SCRATCH, SHOP_POINT } from './lib.mjs';

const [OUT, MODE = 'phone'] = process.argv.slice(2);
const VIEWPORT = MODE === 'phone' ? { width: 390, height: 844 } : { width: 1366, height: 768 };
const DIR = `${OUT}/e2e-${MODE}`;
mkdirSync(DIR, { recursive: true });
const state = loadState();
const seq = Date.now().toString(36);
const POINT = { latitude: SHOP_POINT.latitude + (MODE === 'phone' ? 0.03 : 0.04), longitude: SHOP_POINT.longitude };
const SHOP_NAME = MODE === 'phone' ? `Gupta Print Point ${seq.slice(-3)}` : `Campus Copy Hub ${seq.slice(-3)}`;
const pdfPath = `${SCRATCH}/e2e-${MODE}.pdf`;
writeFileSync(pdfPath, await makePdf(3, 'Physics-lab-record'));

const log = [];
const problems = [];
let shot = 0;
const step = (text) => { log.push(text); console.log(`- ${text}`); };
async function snap(page, name) {
  shot += 1;
  const file = `${DIR}/${String(shot).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file });
  return file;
}
function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`${who} page error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`${who} console: ${m.text().slice(0, 160)}`); });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) problems.push(`${who} ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
  });
}

const browser = await chromium.launch();
const mobile = MODE === 'phone' ? { hasTouch: true, isMobile: true } : {};
const geo = { permissions: ['geolocation'], geolocation: { ...POINT, accuracy: 10 } };
let pc;
try {
  // ---- owner: register and set up ----------------------------------------------------------
  const owner = await browser.newContext({ viewport: VIEWPORT, ...mobile, ...geo });
  await owner.addInitScript(() => localStorage.setItem('printq:installPromptDismissed', '1'));
  const o = await owner.newPage();
  watch(o, 'owner');
  await o.goto(`${WEB}/dashboard/register`, { waitUntil: 'networkidle' });
  await o.getByLabel('Shop name').fill(SHOP_NAME);
  await o.getByLabel('Shop address').fill('Shop 7, Station Road, near the bus stop');
  await o.getByLabel(/Owner name|Your name/).fill('Neha Gupta');
  await o.getByLabel('Email').fill(`e2e.${MODE}.${seq}@ux.printq.local`);
  await o.getByLabel('Password', { exact: true }).fill('Counter-Desk-2026');
  await snap(o, 'register-filled');
  await o.getByRole('button', { name: /Create shop/ }).click();
  await o.waitForURL(/\/dashboard\/setup/, { timeout: 20_000 });
  step('owner registered and landed on Setup');
  const token = await o.evaluate(() => localStorage.getItem('printq:shop:token'));
  const save = o.getByRole('button', { name: 'Save location' });
  await waitFor('pin placed', async () => (await save.isEnabled().catch(() => false)) || null, 20_000);
  await snap(o, 'setup-location');
  await save.click();
  await waitFor('location saved', async () => (await api('/api/shop/setup-status', { token })).data.setup?.locationReady || null, 10_000);
  step('location saved from the device position');

  // ---- counter PC (outside the web app) ------------------------------------------------------
  const agent = await must('agent', api('/api/shop/agents', { method: 'POST', token, body: { machineLabel: 'Counter PC', connectedPrinterIds: [] } }));
  const out = openSync(`${SCRATCH}/e2e-pc-${MODE}.log`, 'w');
  pc = spawn(process.execPath, ['fake-counter-pc.mjs'], {
    env: { ...process.env, FAKE_AGENT_TOKEN: agent.token, FAKE_PRINTERS: '[{"name":"PrintQ Simulator","paperSizes":["A4"]}]' },
    stdio: ['ignore', out, out],
  });
  await waitFor('pc online', async () => ((await api('/api/shop/agents', { token })).data.agents ?? []).some((a) => a.status === 'online' && a.detectedPrinters?.length) || null, 20_000);
  step('counter PC online with the PrintQ Simulator (stand-in for the desktop app)');
  const add = o.locator('.detected-list, .detected-grid').getByRole('button', { name: /Add/ }).first();
  await add.waitFor({ timeout: 20_000 }); // the setup page polls every few seconds
  await snap(o, 'setup-printer-found');
  await add.click();
  await o.getByRole('button', { name: /No, black/ }).first().click();
  const live = await waitFor('live', async () => ((await api('/api/shop/setup-status', { token })).data.setup?.visibility?.state === 'live') || null, 20_000);
  await o.waitForTimeout(1500);
  await snap(o, 'setup-live');
  step(`shop is live (${live ? 'visibility: live' : 'not live'})`);
  const me = (await api('/api/shop/me', { token })).data;
  const slug = me.shop.slug;
  await o.getByRole('link', { name: 'Counter', exact: true }).first().click();
  await o.waitForURL(/\/dashboard$/, { timeout: 10_000 });
  await o.getByRole('textbox', { name: 'Counter code' }).waitFor();
  await snap(o, 'counter-empty');
  step('owner opened the counter');

  // ---- student: sign up, order, check in -----------------------------------------------------
  const student = await browser.newContext({ viewport: VIEWPORT, ...mobile, ...geo });
  await student.addInitScript(() => localStorage.setItem('printq:installPromptDismissed', '1'));
  const s = await student.newPage();
  watch(s, 'student');
  const phone = String(state.nextPhone);
  state.nextPhone += 1;
  saveState(state);
  await s.goto(`${WEB}/`, { waitUntil: 'networkidle' });
  await snap(s, 'welcome');
  await s.getByRole('link', { name: /Start a print/ }).first().click();
  await s.getByLabel('Mobile number').fill(phone);
  await s.getByRole('button', { name: /Send secure code|Send code/ }).click();
  const code = await waitFor('otp', async () => {
    const l = readFileSync(`${SCRATCH}/api.log`, 'utf8');
    return [...l.matchAll(/"phone":"([^"]+)","loginCode":"(\d{6})"/g)].reverse().find((x) => x[1].endsWith(phone))?.[2] ?? null;
  });
  await s.getByLabel('Six-digit verification code').fill(code);
  if (await s.getByRole('button', { name: 'Verify and continue' }).isVisible().catch(() => false)) await s.getByRole('button', { name: 'Verify and continue' }).click();
  await s.getByLabel('Full name').fill('Arjun Mehta');
  await s.getByRole('button', { name: /Finish setup|Continue/ }).click();
  await s.waitForURL(/\/home|\/shops/, { timeout: 15_000 });
  step('student signed up with a new phone number (login code from the dev console provider)');
  if (s.url().includes('/home')) await s.getByRole('button', { name: /New print/ }).first().click();
  await s.waitForURL(/\/shops/, { timeout: 15_000 });
  await s.waitForLoadState('networkidle');
  const listed = s.getByRole('link', { name: new RegExp(SHOP_NAME) }).first();
  if (await listed.isVisible().catch(() => false)) {
    await snap(s, 'directory');
    await listed.click();
    step('student found the new shop in the directory');
  } else {
    await snap(s, 'directory-not-listed');
    problems.push('new shop not visible in the directory at the student position; opened its link instead');
    await s.goto(`${WEB}/s/${slug}`, { waitUntil: 'networkidle' });
  }
  await s.waitForURL(new RegExp(`/s/${slug}`));
  await snap(s, 'shop-landing');
  const chooser = s.waitForEvent('filechooser');
  await s.getByRole('button', { name: /Choose files/ }).first().click();
  await (await chooser).setFiles(pdfPath);
  await s.waitForURL(/\/file\//, { timeout: 30_000 });
  const place = s.getByRole('button', { name: /Place order/ }).first();
  await waitFor('total', async () => (await place.isEnabled().catch(() => false)) || null, 20_000);
  await s.waitForTimeout(800);
  await snap(s, 'checkout');
  const shownTotal = (await s.locator('.checkout-bar, .checkout-total, .total').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  await place.click();
  await s.waitForURL(/\/jobs\//, { timeout: 20_000 });
  const jobId = s.url().split('/jobs/')[1].split(/[?#]/)[0];
  await s.waitForTimeout(1000);
  await snap(s, 'job-prepared');
  step(`student placed the order (checkout showed: "${shownTotal.slice(0, 80)}")`);
  await s.getByRole('button', { name: /I.m here/ }).first().click();
  const ticket = s.locator('[data-counter-code]').first();
  await ticket.waitFor({ timeout: 20_000 });
  await s.waitForTimeout(500);
  await snap(s, 'job-your-turn');
  const counterCode = (await ticket.locator('.sr-only').innerText()).replace(/\D/g, '');
  step(`student checked in with one tap and sees the counter code (${counterCode.length} digits)`);

  // ---- counter: release with payment confirmation -------------------------------------------
  const box = o.getByRole('textbox', { name: 'Counter code' });
  await box.click();
  await box.pressSequentially(counterCode, { delay: 60 });
  const cash = o.getByRole('button', { name: 'Cash received & print' });
  await cash.waitFor({ timeout: 15_000 });
  await snap(o, 'counter-order-card');
  const card = (await o.locator('.order-card, [data-order-card]').first().innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  step(`counter found the order after the 6th digit (card: "${card.slice(0, 120)}")`);
  await cash.click();
  await o.getByRole('status').filter({ hasText: /Sent to/ }).first().waitFor({ timeout: 15_000 });
  await snap(o, 'counter-sent');
  const focused = await o.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName);
  step(`cash confirmed and sent to print; focus back on: ${focused}`);
  const printedOk = o.locator('[data-job-card]').getByRole('button', { name: /Printed OK · hand over/ }).first();
  await printedOk.waitFor({ timeout: 30_000 });
  await snap(o, 'counter-printed-check');
  step('counter PC reported the print as sent; staff asked to check the pages');
  await snap(s, 'job-printing');
  await printedOk.click();
  await waitFor('collected', async () => {
    const j = (await api(`/api/jobs/${jobId}`, { token: await s.evaluate(() => localStorage.getItem('printq:student:token')) })).data.job;
    return j && /collected|completed/.test(j.status) ? j : null;
  }, 20_000);
  await o.waitForTimeout(1200);
  await snap(o, 'counter-after-handover');
  await s.waitForTimeout(1500);
  await snap(s, 'job-collected');
  const finalJob = (await api(`/api/jobs/${jobId}`, { token: await s.evaluate(() => localStorage.getItem('printq:student:token')) })).data.job;
  step(`handed over: job status ${finalJob.status}, payment ${finalJob.paymentStatus}, total ₹${finalJob.totalPaise / 100}`);

  // ---- owner: history and earnings -----------------------------------------------------------
  await o.getByRole('link', { name: 'History', exact: true }).first().click();
  await o.waitForURL(/history/);
  await o.getByText('Arjun').first().waitFor({ timeout: 10_000 });
  await snap(o, 'history');
  step('history lists the order');
  await o.getByRole('link', { name: 'Earnings', exact: true }).first().click();
  await o.waitForURL(/earnings/);
  await o.waitForLoadState('networkidle');
  await o.waitForTimeout(1000);
  await snap(o, 'earnings');
  const earnings = (await o.locator('main, .page').first().innerText()).replace(/\s+/g, ' ');
  const shows = earnings.includes(String(finalJob.totalPaise / 100));
  step(`earnings page ${shows ? 'shows' : 'does NOT show'} ₹${finalJob.totalPaise / 100}`);
  if (!shows) problems.push('earnings did not show the order amount');

  writeFileSync(`${DIR}/result.json`, JSON.stringify({ mode: MODE, viewport: VIEWPORT, shop: SHOP_NAME, steps: log, problems, finalStatus: finalJob.status, paymentStatus: finalJob.paymentStatus }, null, 2));
  console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'no problems');
} catch (e) {
  problems.push(String(e).slice(0, 400));
  writeFileSync(`${DIR}/result.json`, JSON.stringify({ mode: MODE, viewport: VIEWPORT, shop: SHOP_NAME, steps: log, problems, failed: true }, null, 2));
  console.log(`FAILED: ${String(e).slice(0, 400)}`);
  for (const ctx of browser.contexts()) for (const p of ctx.pages()) await p.screenshot({ path: `${SCRATCH}/e2e-fail-${MODE}-${Math.random().toString(36).slice(2, 6)}.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  pc?.kill();
  await browser.close();
}
