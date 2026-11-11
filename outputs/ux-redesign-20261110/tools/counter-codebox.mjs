// Evidence: is the counter code box focused on load and fully on screen, at every viewport? (local stack)
// Usage: UX_SCRATCH=... node counter-codebox.mjs <out.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadState, WEB } from './lib.mjs';
const state = loadState();
const views = [[360, 640], [390, 844], [768, 1024], [1280, 720], [1366, 768], [1920, 1080]];
const browser = await chromium.launch();
const out = [];
for (const [width, height] of views) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript(([t]) => { localStorage.setItem('printq:installPromptDismissed', '1'); localStorage.setItem('printq:shop:token', t); localStorage.setItem('printq:shop:role', 'owner'); }, [state.shopA.token]);
  const page = await ctx.newPage();
  await page.goto(`${WEB}/dashboard`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const r = await page.evaluate(() => {
    const el = document.getElementById('counter-code');
    const b = el?.getBoundingClientRect();
    return { found: Boolean(el), focused: document.activeElement === el, top: b && Math.round(b.top), bottom: b && Math.round(b.bottom), inputMode: el?.getAttribute('inputmode') ?? null, scrollY: window.scrollY };
  });
  const row = { viewport: `${width}x${height}`, ...r, onScreen: r.found && r.top >= 0 && r.bottom <= height };
  out.push(row);
  console.log(JSON.stringify(row));
  await ctx.close();
}
await browser.close();
writeFileSync(process.argv[2], JSON.stringify(out, null, 2));
