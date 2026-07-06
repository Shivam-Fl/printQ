// Drives real Chromium to screenshot every PrintQ screen for design review.
// Usage: node scripts/shots.mjs <outDir> <tokensJson>
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2] ?? 'shots';
const BASE = 'http://localhost:5173';
const API = 'http://localhost:4000';
mkdirSync(OUT, { recursive: true });
const tokens = JSON.parse(readFileSync(process.argv[3] ?? 'tokens.json', 'utf8'));

async function apiGet(path, token) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res.json() : null;
}

const browser = await chromium.launch();

async function shoot(label, { path, token, role, width, height, waitMs = 1300 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(
    ([r, t]) => {
      if (t) localStorage.setItem(`printq:${r}:token`, t);
    },
    [role, token],
  );
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
  if (errors.length) console.log(`  [${label}] errors:`, errors.slice(0, 3));
  await ctx.close();
}

const M = { width: 390, height: 844 };
const D = { width: 1440, height: 900 };

const jobsData = await apiGet('/api/jobs', tokens.student);
const jobs = jobsData?.jobs ?? [];
const byStatus = (s) => jobs.find((j) => j.status === s)?.id;
const anyJob = jobs[0]?.id;
const completed = byStatus('completed') ?? anyJob;
const notified = byStatus('notified');
const queued = byStatus('queued');
console.log('jobs:', jobs.length, 'completed:', completed, 'notified:', notified, 'queued:', queued);

// ---- student (mobile) ----
await shoot('01-welcome', { path: '/', token: '', role: 'student', ...M });
await shoot('02-login', { path: '/login', token: '', role: 'student', ...M });
await shoot('03-home', { path: '/home', token: tokens.student, role: 'student', ...M });
await shoot('04-jobs', { path: '/jobs', token: tokens.student, role: 'student', ...M });
await shoot('05-profile', { path: '/profile', token: tokens.student, role: 'student', ...M });
await shoot('06-shop-landing', { path: '/s/demo', token: tokens.student, role: 'student', ...M });
if (completed) await shoot('07-job-completed', { path: `/jobs/${completed}`, token: tokens.student, role: 'student', ...M });
if (queued) await shoot('08-job-queued', { path: `/jobs/${queued}`, token: tokens.student, role: 'student', ...M });
if (notified) await shoot('09-job-notified', { path: `/jobs/${notified}`, token: tokens.student, role: 'student', ...M });

// ---- shop (desktop) ----
await shoot('20-shop-dashboard', { path: '/dashboard', token: tokens.shop, role: 'shop', ...D });
await shoot('21-shop-printers', { path: '/dashboard/printers', token: tokens.shop, role: 'shop', ...D });

await browser.close();
console.log('done ->', OUT);
