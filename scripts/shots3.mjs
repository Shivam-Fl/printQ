import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';

const OUT = process.argv[2];
const tok = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const BASE = 'http://localhost:5173';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function shoot(label, { path, token, role, width, height, waitMs = 1400 }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await page.addInitScript(([r, t]) => t && localStorage.setItem(`printq:${r}:token`, t), [role, token]);
  const errs = [];
  page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(waitMs);
  await page.screenshot({ path: `${OUT}/${label}.png`, fullPage: true });
  if (errs.length) console.log(`  [${label}]`, errs.slice(0, 2));
  await ctx.close();
}

const M = { width: 390, height: 844 };
const D = { width: 1440, height: 950 };

await shoot('30-settings', { path: '/dashboard/settings', token: tok.shop, role: 'shop', ...D });
await shoot('31-insights', { path: '/dashboard/insights', token: tok.shop, role: 'shop', ...D });
await shoot('32-history', { path: '/dashboard/history', token: tok.shop, role: 'shop', ...D });
await shoot('33-shop-landing-multi', { path: '/s/demo', token: tok.student, role: 'student', ...M });
await shoot('34-newjob-options', { path: `/s/demo/file/${tok.fileId}`, token: tok.student, role: 'student', ...M });

await browser.close();
console.log('done ->', OUT);
