// axe-core (WCAG 2.x A/AA rules) on the main pages at phone and desktop widths.
// axe-core is installed outside the repo; pass its path: node axe.mjs <out.json> <path/to/axe.min.js>
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadState, WEB } from './lib.mjs';

const [OUT, AXE] = process.argv.slice(2);
const axeSource = readFileSync(AXE, 'utf8');
const state = loadState();
const S = state.students;
const A = state.shopA;
const pages = [
  ['welcome', '/', null],
  ['student-login', '/login', null],
  ['shop-directory', '/shops', ['student', S.aarav.token]],
  ['shop-landing', `/s/${A.slug}`, ['student', S.aarav.token]],
  ['home', '/home', ['student', S.aarav.token]],
  ['checkout', `/s/${A.slug}/file/${state.checkoutFileId}`, ['student', S.meera.token]],
  ['job-prepared', `/jobs/${S.priya.jobs.prepared}`, ['student', S.priya.token]],
  ['job-in-line', `/jobs/${S.aarav.jobs.line}`, ['student', S.aarav.token]],
  ['shop-login', '/dashboard/login', null],
  ['shop-register', '/dashboard/register', null],
  ['counter', '/dashboard', ['shop', A.token, 'owner']],
  ['setup', '/dashboard/setup', ['shop', state.shopB.token, 'owner']],
  ['prices', '/dashboard/prices', ['shop', A.token, 'owner']],
  ['printers', '/dashboard/printers', ['shop', A.token, 'owner']],
  ['settings', '/dashboard/settings', ['shop', A.token, 'owner']],
  ['earnings', '/dashboard/earnings', ['shop', A.token, 'owner']],
  ['history', '/dashboard/history', ['shop', A.token, 'owner']],
  ['pc', '/pc', null],
  ['support', '/support', null],
];
const viewports = { phone: { width: 390, height: 844 }, desktop: { width: 1366, height: 768 } };
const browser = await chromium.launch();
const results = [];
for (const [vpName, viewport] of Object.entries(viewports)) {
  for (const [name, path, auth] of pages) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript(([a]) => {
      localStorage.setItem('printq:installPromptDismissed', '1');
      if (a) { localStorage.setItem(`printq:${a[0]}:token`, a[1]); if (a[2]) localStorage.setItem('printq:shop:role', a[2]); }
    }, [auth]);
    const page = await ctx.newPage();
    await page.goto(`${WEB}${path}`, { waitUntil: 'networkidle' }).catch(() => undefined);
    await page.waitForTimeout(1200);
    await page.addScriptTag({ content: axeSource });
    const res = await page.evaluate(async () => {
      // eslint-disable-next-line no-undef
      const r = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') ?? '' }));
    });
    results.push({ page: name, viewport: vpName, violations: res });
    console.log(`${vpName.padEnd(7)} ${name.padEnd(15)} ${res.length === 0 ? 'clean' : res.map((v) => `${v.impact}:${v.id}(${v.nodes}) ${v.sample}`).join(' | ')}`);
    await ctx.close();
  }
}
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 2));
