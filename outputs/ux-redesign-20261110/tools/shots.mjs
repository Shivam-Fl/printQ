// Screenshots every route x state x viewport and records layout metrics.
// Usage: UX_SCRATCH=... node shots.mjs <outDir> [filterRegex]
// Writes <outDir>/*.png and <outDir>/metrics.json. Local stack only.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { api, loadState, saveState, WEB, createOrder } from './lib.mjs';

const OUT = process.argv[2];
const FILTER = process.argv[3] ? new RegExp(process.argv[3]) : null;
if (!OUT) throw new Error('usage: node shots.mjs <outDir> [filter]');
mkdirSync(OUT, { recursive: true });
const state = loadState();
const S = state.students;
const A = state.shopA;

const V = {
  m360: { width: 360, height: 640 },
  m390: { width: 390, height: 844 },
  t768: { width: 768, height: 1024 },
  d1280: { width: 1280, height: 720 },
  d1366: { width: 1366, height: 768 },
  d1920: { width: 1920, height: 1080 },
};
const ALL = Object.keys(V);
const PHONES = ['m360', 'm390'];
const KEY = ['m390', 'd1366'];

// Session helpers -------------------------------------------------------------
async function adminToken() {
  const cred = JSON.parse((await import('node:fs')).readFileSync(`${process.env.UX_SCRATCH}/admin-cred.json`, 'utf8'));
  const r = await api('/api/admin/auth/login', { method: 'POST', body: cred });
  return r.data.token;
}
async function staffToken() {
  if (!state.staffA) {
    const email = 'counter.staff@ux.printq.local';
    await api('/api/shop/staff', { method: 'POST', token: A.token, body: { email, name: 'Counter Staff', pin: '4826' } });
    state.staffA = { email, pin: '4826' };
    saveState(state);
  }
  const r = await api('/api/auth/shop/staff-login', { method: 'POST', body: { email: state.staffA.email, pin: state.staffA.pin } });
  return r.data.token;
}
async function checkoutFile() {
  // a fresh, un-ordered upload for the new student so the checkout page has a real file
  if (!state.checkoutFileId) {
    const form = new FormData();
    const { makePdf } = await import('./lib.mjs');
    form.append('shopSlug', A.slug);
    form.append('files', new Blob([await makePdf(8, 'Data-structures-assignment')], { type: 'application/pdf' }), 'Data-structures-assignment.pdf');
    const up = await api('/api/files', { method: 'POST', token: S.meera.token, formData: form });
    state.checkoutFileId = up.data.file.id;
    saveState(state);
  }
  return state.checkoutFileId;
}

const tokens = {
  admin: await adminToken(),
  staff: await staffToken(),
};
const fileId = await checkoutFile();
const job = (who, label) => S[who].jobs[label];

// Route table -----------------------------------------------------------------
// role: which localStorage token to plant; mode: optional network condition.
const R = [
  ['01-welcome', '/', null, ALL],
  ['02-student-login', '/login', null, ['m360', 'm390', 'd1366']],
  ['03-shop-directory', '/shops', ['student', S.aarav.token], ['m360', 'm390', 'd1366']],
  ['04-shop-landing', `/s/${A.slug}`, ['student', S.aarav.token], ['m360', 'm390', 't768', 'd1366']],
  ['04b-shop-landing-signed-out', `/s/${A.slug}`, null, ['m390']],
  ['05-home-new-student', '/home', ['student', S.meera.token], PHONES],
  ['06-home-returning', '/home', ['student', S.aarav.token], ['m360', 'm390', 'd1366']],
  ['07-checkout', `/s/${A.slug}/file/${fileId}`, ['student', S.meera.token], ['m360', 'm390', 't768', 'd1280', 'd1366']],
  ['08-job-prepared', `/jobs/${job('priya', 'prepared')}`, ['student', S.priya.token], PHONES],
  ['09-job-scheduled', `/jobs/${job('aarav', 'scheduled')}`, ['student', S.aarav.token], ['m390']],
  ['10-job-at-counter', `/jobs/${job('priya', 'line')}`, ['student', S.priya.token], ['m360', 'm390', 'd1366']],
  ['11-job-arriving', `/jobs/${job('rohan', 'line')}`, ['student', S.rohan.token], ['m390']],
  ['12-job-waiting', `/jobs/${job('kabir', 'line')}`, ['student', S.kabir.token], ['m390']],
  ['13-job-absent', `/jobs/${job('kabir', 'absent')}`, ['student', S.kabir.token], ['m390']],
  ['14-job-printing', `/jobs/${job('rohan', 'printing')}`, ['student', S.rohan.token], ['m390']],
  ['15-job-ready', `/jobs/${job('priya', 'ready')}`, ['student', S.priya.token], ['m360', 'm390']],
  ['16-job-finishing', `/jobs/${job('ananya', 'finishing')}`, ['student', S.ananya.token], ['m390']],
  ['17-job-completed', `/jobs/${job('aarav', 'done1')}`, ['student', S.aarav.token], ['m390']],
  ['18-job-cancelled', `/jobs/${job('kabir', 'cancelled')}`, ['student', S.kabir.token], ['m390']],
  ['19-my-jobs', '/jobs', ['student', S.aarav.token], ['m390', 'd1366']],
  ['20-profile', '/profile', ['student', S.aarav.token], ['m390']],
  ['21-privacy', '/privacy', null, KEY],
  ['21-terms', '/terms', null, KEY],
  ['21-refunds', '/refunds', null, ['m390']],
  ['21-support', '/support', null, KEY],
  ['22-pc', '/pc', null, KEY],
  ['23-not-found', '/no-such-page', null, ['m390']],
  ['23-unknown-shop', '/s/no-such-shop', null, ['m390']],
  ['30-shop-login', '/dashboard/login', null, KEY],
  ['31-shop-register', '/dashboard/register', null, ['m360', 'm390', 'd1366']],
  ['32-counter', '/dashboard', ['shop', A.token, 'owner'], ALL],
  ['32b-counter-staff', '/dashboard', ['shop', tokens.staff, 'staff'], ['m390', 'd1366']],
  ['34-setup-live', '/dashboard/setup', ['shop', A.token, 'owner'], KEY],
  ['35-setup-new', '/dashboard/setup', ['shop', state.shopB.token, 'owner'], ['m360', 'm390', 'd1366']],
  ['36-setup-practice', '/dashboard/setup', ['shop', state.shopC.token, 'owner'], KEY],
  ['37-printers', '/dashboard/printers', ['shop', A.token, 'owner'], ['m390', 'd1280', 'd1366']],
  ['37b-printers-practice', '/dashboard/printers', ['shop', state.shopC.token, 'owner'], KEY],
  ['38-computers', '/dashboard/agents', ['shop', A.token, 'owner'], KEY],
  ['38b-computers-new', '/dashboard/agents', ['shop', state.shopB.token, 'owner'], KEY],
  ['39-settings', '/dashboard/settings', ['shop', A.token, 'owner'], ['m390', 'd1366']],
  ['40-earnings', '/dashboard/earnings', ['shop', A.token, 'owner'], KEY],
  ['41-insights', '/dashboard/insights', ['shop', A.token, 'owner'], KEY],
  ['42-history', '/dashboard/history', ['shop', A.token, 'owner'], KEY],
  ['43-counter-new-shop', '/dashboard', ['shop', state.shopB.token, 'owner'], ['m390', 'd1280']],
  ['50-admin-login', '/admin/login', null, KEY],
  ['51-admin', '/admin', ['admin', tokens.admin], KEY],
  // degraded network states
  ['60-counter-offline', '/dashboard', ['shop', A.token, 'owner'], ['d1366'], 'offline-after-load'],
  ['61-counter-api-down', '/dashboard', ['shop', A.token, 'owner'], ['d1366'], 'api-503'],
  ['62-home-api-down', '/home', ['student', S.aarav.token], ['m390'], 'api-503'],
  ['63-counter-loading', '/dashboard', ['shop', A.token, 'owner'], ['d1366'], 'slow'],
  ['64-job-loading', `/jobs/${job('priya', 'line')}`, ['student', S.priya.token], ['m390'], 'slow'],
];

const browser = await chromium.launch();
const metrics = [];

async function shoot([label, path, auth, viewports, mode]) {
  for (const vk of viewports) {
    const name = `${label}@${V[vk].width}x${V[vk].height}`;
    if (FILTER && !FILTER.test(name)) continue;
    const ctx = await browser.newContext({ viewport: V[vk], deviceScaleFactor: 1 });
    await ctx.addInitScript(([a]) => {
      if (!a) return;
      localStorage.setItem(`printq:${a[0]}:token`, a[1]);
      if (a[2]) localStorage.setItem('printq:shop:role', a[2]);
      // keep the install banner out of every shot
      localStorage.setItem('printq:installPromptDismissed', '1');
    }, [auth]);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
    if (mode === 'api-503') await page.route('**/api/**', (r) => r.fulfill({ status: 503, body: '{"error":"Service Unavailable"}', contentType: 'application/json' }));
    if (mode === 'slow') await page.route('**/api/**', async (r) => { await new Promise((x) => setTimeout(x, 4000)); await r.continue().catch(() => undefined); });
    await page.goto(`${WEB}${path}`, { waitUntil: mode === 'slow' ? 'domcontentloaded' : 'networkidle', timeout: 30_000 }).catch(() => undefined);
    if (mode === 'offline-after-load') {
      await page.waitForTimeout(1200);
      await ctx.setOffline(true);
      await page.evaluate(() => window.dispatchEvent(new Event('offline')));
      await page.locator('input').first().fill('123456').catch(() => undefined);
      await page.keyboard.press('Enter').catch(() => undefined);
    }
    await page.waitForTimeout(mode === 'slow' ? 900 : 1300);
    const m = await page.evaluate(() => {
      const de = document.documentElement;
      const code = document.querySelector('input[aria-label*="code" i], input[autocomplete="one-time-code"], .big-otp-input');
      const r = code?.getBoundingClientRect();
      const primary = [...document.querySelectorAll('button, a.button-link')].filter((b) => b.offsetParent);
      return {
        scrollWidth: de.scrollWidth,
        innerWidth: window.innerWidth,
        pageHeight: de.scrollHeight,
        hOverflow: de.scrollWidth > window.innerWidth + 1,
        codeInput: r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.bottom <= window.innerHeight && r.top >= 0, focused: document.activeElement === code } : null,
        buttons: primary.length,
        textLength: document.body.innerText.length,
        title: document.title,
      };
    });
    await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
    if (vk.startsWith('d') || vk === 'm390') await page.screenshot({ path: `${OUT}/${name}.fold.png`, fullPage: false });
    metrics.push({ name, path, mode: mode ?? null, ...m, errors });
    await ctx.close();
  }
}

for (const route of R) {
  try { await shoot(route); } catch (e) { metrics.push({ name: route[0], error: String(e).slice(0, 300) }); }
}
await browser.close();
// merge with earlier partial runs (keyed by shot name)
const { existsSync, readFileSync } = await import('node:fs');
const previous = existsSync(`${OUT}/metrics.json`) ? JSON.parse(readFileSync(`${OUT}/metrics.json`, 'utf8')) : [];
const merged = new Map(previous.map((m) => [m.name, m]));
for (const m of metrics) merged.set(m.name, m);
writeFileSync(`${OUT}/metrics.json`, JSON.stringify([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), null, 2));
console.log(`shots: ${metrics.length} -> ${OUT}`);
const bad = metrics.filter((m) => m.hOverflow || m.error);
if (bad.length) console.log('overflow/errors:', bad.map((m) => `${m.name}${m.error ? ' ERR ' + m.error : ''}`).join('\n'));
