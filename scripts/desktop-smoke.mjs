import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Usage: node scripts/desktop-smoke.mjs [--dev]
//   default  tests the packaged app in apps/agent/release/win-unpacked (run package:windows first)
//   --dev    tests the compiled sources in apps/agent/dist with the local Electron
// PRINTQ_SMOKE_SKIP_LOCATION=1 skips the real-location check on a PC with no location hardware.

if (process.platform !== 'win32') {
  console.log('Desktop smoke skipped: Windows only');
  process.exit(0);
}

const LOCATION_TIMEOUT_MS = 20_000;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentDir = path.join(repositoryRoot, 'apps', 'agent');
const useDevBuild = process.argv.includes('--dev');
const userDataDir = await mkdtemp(path.join(tmpdir(), 'printqs-desktop-smoke-'));
const logLines = [];
let desktop;

/** Windows "Location services" (device or user) or "Let desktop apps access your location" turned off. */
function windowsLocationOffReason() {
  const base = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\location';
  const checks = [
    [`HKLM\\${base}`, 'Location services are off for this device'],
    [`HKCU\\${base}`, 'Location services are off for this Windows user'],
    [`HKCU\\${base}\\NonPackaged`, "'Let desktop apps access your location' is off"],
  ];
  for (const [key, reason] of checks) {
    try {
      const output = execFileSync('reg', ['query', key, '/v', 'Value'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/\bDeny\b/i.test(output)) return reason;
    } catch {
      // Missing key means Windows has not stored a choice; treat it as on.
    }
  }
  return null;
}

/** Chromium's Google network provider without a key: what the desktop app did before the PlatformOnly switch. */
const isGoogleLocation401 = (line) => (/googleapis\.com/i.test(line) && /401/.test(line)) || /Returned error code 401/i.test(line);

function recordLogs(source, text) {
  for (const line of String(text).split(/\r?\n/).filter(Boolean)) logLines.push(`[${source}] ${line}`);
}

function assertNoGoogleLocation401() {
  const bad = logLines.filter(isGoogleLocation401);
  if (bad.length > 0) {
    throw new Error(`Desktop app used Google's network location API and got 401 (Windows location switch missing?):\n${bad.join('\n')}`);
  }
}

try {
  const launchOptions = useDevBuild
    ? {
      executablePath: createRequire(path.join(agentDir, 'package.json'))('electron'),
      args: [agentDir, `--user-data-dir=${userDataDir}`],
    }
    : {
      executablePath: path.join(agentDir, 'release', 'win-unpacked', 'PrintQs Shop.exe'),
      args: [`--user-data-dir=${userDataDir}`],
    };
  // PRINTQ_DESKTOP_SMOKE keeps this run from rewriting the installed app's autostart entry.
  const env = { ...process.env, PRINTQ_WEB_URL: 'https://printqs.com', PRINTQ_DESKTOP_SMOKE: '1' };
  // Inherited from VS Code-hosted terminals; it would start Electron as plain Node.
  delete env.ELECTRON_RUN_AS_NODE;
  desktop = await electron.launch({ ...launchOptions, env });
  desktop.process().stdout?.on('data', (chunk) => recordLogs('main', chunk));
  desktop.process().stderr?.on('data', (chunk) => recordLogs('main', chunk));
  desktop.on('console', (message) => recordLogs('main', message.text()));

  const page = await desktop.firstWindow();
  page.on('console', (message) => recordLogs('page', message.text()));
  // The app opens /dashboard and the web app then redirects a signed-out
  // first run to /dashboard/login; wait for that, not the first match.
  await page.waitForURL(/printqs\.com\/dashboard\/login/, { timeout: 30_000 });
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

  // Real location on https://printqs.com/dashboard/login, the same call shop setup makes.
  const location = await page.evaluate((timeout) => new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ ok: false, code: 0, message: 'navigator.geolocation is missing' });
      return;
    }
    const startedAt = performance.now();
    const guard = setTimeout(() => resolve({ ok: false, code: 3, message: 'No answer from navigator.geolocation' }), timeout + 5_000);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(guard);
        resolve({ ok: true, accuracyM: Math.round(position.coords.accuracy), ms: Math.round(performance.now() - startedAt) });
      },
      (error) => {
        clearTimeout(guard);
        resolve({ ok: false, code: error.code, message: error.message, ms: Math.round(performance.now() - startedAt) });
      },
      { enableHighAccuracy: false, timeout, maximumAge: 0 },
    );
  }), LOCATION_TIMEOUT_MS);
  // Give late log lines from the location provider a moment to arrive.
  await page.waitForTimeout(1_000);
  assertNoGoogleLocation401();

  let locationSummary;
  if (location.ok) {
    locationSummary = `found, about ${location.accuracyM} m accuracy in ${location.ms} ms`;
  } else {
    const offReason = windowsLocationOffReason();
    const detail = `code ${location.code}: ${location.message}`;
    if (offReason) {
      locationSummary = `SKIPPED - ${offReason} in Windows Settings > Privacy & security > Location (${detail})`;
    } else if (process.env.PRINTQ_SMOKE_SKIP_LOCATION === '1') {
      locationSummary = `SKIPPED by PRINTQ_SMOKE_SKIP_LOCATION (${detail})`;
    } else if (location.code === 2) {
      throw new Error(`Location failed with POSITION_UNAVAILABLE although Windows location is on (${detail}). The desktop app cannot place the shop pin.`);
    } else if (location.code === 1) {
      throw new Error(`Location was denied on printqs.com although the app grants it (${detail}).`);
    } else {
      throw new Error(`No location within ${LOCATION_TIMEOUT_MS / 1_000} s (${detail}). On a PC with no Wi-Fi or location hardware, rerun with PRINTQ_SMOKE_SKIP_LOCATION=1.`);
    }
  }
  console.log(`Desktop smoke passed (${useDevBuild ? 'dev build' : 'packaged app'}): ${JSON.stringify(result)}; location ${locationSummary}`);
} finally {
  await desktop?.close().catch(() => undefined);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
}
