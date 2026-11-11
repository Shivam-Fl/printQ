// Throttled load of the main routes against the production build (vite preview on :4173).
// DevTools "Fast 3G" (562.5 ms RTT, 1.44 Mbps down, 675 Kbps up) + 4x CPU slowdown, cold cache.
// Usage: UX_SCRATCH=... node perf.mjs <out.json>
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { loadState } from './lib.mjs';

const OUT = process.argv[2];
const BASE = process.env.UX_PREVIEW ?? 'http://localhost:4173';
const state = loadState();
const S = state.students;
const A = state.shopA;
const routes = [
  ['welcome', '/', null],
  ['student-login', '/login', null],
  ['shop-landing', `/s/${A.slug}`, ['student', S.aarav.token]],
  ['home', '/home', ['student', S.aarav.token]],
  ['checkout', `/s/${A.slug}/file/${state.checkoutFileId}`, ['student', S.meera.token]],
  ['job-status', `/jobs/${S.priya.jobs.ready}`, ['student', S.priya.token]],
  ['counter', '/dashboard', ['shop', A.token, 'owner']],
  ['shop-login', '/dashboard/login', null],
];
const RUNS = 3;
const browser = await chromium.launch();
const results = [];
for (const [name, path, auth] of routes) {
  const runs = [];
  for (let i = 0; i < RUNS; i += 1) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(([a]) => {
      if (a) { localStorage.setItem(`printq:${a[0]}:token`, a[1]); if (a[2]) localStorage.setItem('printq:shop:role', a[2]); }
      localStorage.setItem('printq:installPromptDismissed', '1');
      window.__lcp = 0;
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    }, [auth]);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: (1.44 * 1024 * 1024) / 8, uploadThroughput: (675 * 1024) / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    let bytes = 0;
    cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength; });
    const t0 = Date.now();
    await page.goto(`${BASE}${path}`, { waitUntil: 'load', timeout: 90_000 });
    const loadMs = Date.now() - t0;
    await page.waitForTimeout(2500);
    const m = await page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const nav = performance.getEntriesByType('navigation')[0];
      return { fcp, lcp: window.__lcp || null, dcl: nav?.domContentLoadedEventEnd ?? null };
    });
    runs.push({ ...m, loadMs, kb: Math.round(bytes / 1024) });
    await ctx.close();
  }
  const med = (k) => runs.map((r) => r[k]).filter((v) => v != null).sort((a, b) => a - b)[Math.floor(runs.length / 2)] ?? null;
  results.push({ name, path: path.replace(/[0-9a-f-]{36}/g, ':id'), fcpMs: Math.round(med('fcp')), lcpMs: Math.round(med('lcp')), dclMs: Math.round(med('dcl')), loadMs: med('loadMs'), transferKB: med('kb'), runs: RUNS });
  console.log(results.at(-1));
}
await browser.close();
writeFileSync(OUT, JSON.stringify(results, null, 2));
