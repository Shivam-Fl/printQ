import { _electron as electron } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('Desktop smoke skipped: Windows only');
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(repositoryRoot, 'apps', 'agent', 'release', 'win-unpacked', 'PrintQs Shop.exe');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'printqs-desktop-smoke-'));
let desktop;

try {
  desktop = await electron.launch({
    executablePath,
    args: [`--user-data-dir=${userDataDir}`],
    env: { ...process.env, PRINTQ_WEB_URL: 'https://printqs.com' },
  });
  const page = await desktop.firstWindow();
  await page.waitForURL(/printqs\.com\/dashboard/, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    if (!window.printqsDesktop) throw new Error('Desktop bridge is unavailable');
    const loaded = await window.printqsDesktop.load();
    return {
      title: document.title,
      path: window.location.pathname,
      configured: loaded.config.configured,
      engineState: loaded.status.state,
      appVersion: loaded.appVersion,
    };
  });
  if (result.path !== '/dashboard/login') throw new Error(`Unexpected first-run path: ${result.path}`);
  if (result.configured) throw new Error('Isolated first run should not already be configured');
  if (result.engineState !== 'setup_required') throw new Error(`Unexpected engine state: ${result.engineState}`);
  console.log(`Desktop smoke passed: ${JSON.stringify(result)}`);
} finally {
  await desktop?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true });
}
