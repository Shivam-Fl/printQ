// Screenshots the counter in its interactive states: empty code box, an order looked up
// (pay at shop), out of turn, and right after sending. Usage: node counter-states.mjs <outDir>
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { api, loadState, studentJob, waitFor, WEB } from './lib.mjs';

const OUT = process.argv[2];
mkdirSync(OUT, { recursive: true });
const state = loadState();
const S = state.students;
const A = state.shopA;
const browser = await chromium.launch();

async function codeOf(who, label) {
  const job = await studentJob(S[who].token, S[who].jobs[label]);
  return job?.otpCode ?? null;
}

for (const vp of [{ width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 360, height: 640 }]) {
  const tag = `${vp.width}x${vp.height}`;
  const ctx = await browser.newContext({ viewport: vp });
  await ctx.addInitScript(([t]) => { localStorage.setItem('printq:shop:token', t); localStorage.setItem('printq:shop:role', 'owner'); }, [A.token]);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const focused = await page.evaluate(() => document.activeElement?.id);
  const box = await page.locator('#counter-code').boundingBox();
  console.log(tag, 'focused:', focused, 'code box bottom:', Math.round(box.y + box.height), 'viewport:', vp.height);
  await page.screenshot({ path: `${OUT}/counter-empty@${tag}.png` });
  // a called student (pay at shop)
  const code = await codeOf('aarav', 'line') ?? await codeOf('priya', 'line');
  if (code) {
    await page.locator('#counter-code').pressSequentially(code, { delay: 30 });
    await page.locator('.order-card').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/counter-lookup@${tag}.png` });
    await page.keyboard.press('Escape');
  }
  // someone who is only "coming up" -> out of turn
  const job = await studentJob(S.rohan.token, S.rohan.jobs.line);
  void job;
  await page.screenshot({ path: `${OUT}/counter-full@${tag}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
void api; void waitFor;
