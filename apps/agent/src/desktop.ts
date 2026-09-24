import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  safeStorage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fromStoredDesktopConfig,
  toStoredDesktopConfig,
  type DesktopConfig,
  type SecureStorage,
  type StoredDesktopConfig,
} from './secureConfig.js';
import { restartDelayMs } from './restartPolicy.js';

interface AgentStatus {
  state: 'setup_required' | 'connecting' | 'online' | 'offline' | 'error';
  detail: string;
  lastUpdatedAt: string;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const productionWebUrl = 'https://printqs.com';
const productionApiUrl = 'https://api.printqs.com';
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentProcess: ChildProcess | null = null;
let restartTimer: NodeJS.Timeout | null = null;
let restartAttempts = 0;
let shuttingDown = false;
let status: AgentStatus = {
  state: 'setup_required',
  detail: 'Open Computers to connect this Windows PC to your shop.',
  lastUpdatedAt: new Date().toISOString(),
};

const configPath = () => path.join(app.getPath('userData'), 'shop-config.json');
const secureStorage: SecureStorage = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
  decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
};

async function loadConfig(): Promise<DesktopConfig | null> {
  if (!existsSync(configPath())) return null;
  try {
    const parsed = JSON.parse(await readFile(configPath(), 'utf8')) as StoredDesktopConfig;
    return fromStoredDesktopConfig(parsed, secureStorage);
  } catch {
    return null;
  }
}

async function dashboardUrl(): Promise<string> {
  const config = await loadConfig();
  return (process.env.PRINTQ_WEB_URL || config?.webUrl || productionWebUrl).replace(/\/$/, '');
}

function publicConfig(config: DesktopConfig | null) {
  return {
    configured: Boolean(config),
    apiUrl: config?.apiUrl ?? productionApiUrl,
    webUrl: config?.webUrl ?? productionWebUrl,
    mode: config?.mode ?? 'real',
  };
}

function setStatus(next: AgentStatus['state'], detail: string): void {
  status = { state: next, detail, lastUpdatedAt: new Date().toISOString() };
  mainWindow?.webContents.send('agent:status', status);
  tray?.setToolTip(`PrintQs Shop — ${next.replace('_', ' ')}`);
}

function cancelScheduledRestart(): void {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
}

function stopAgent(): void {
  agentProcess?.kill();
  agentProcess = null;
}

function scheduleRestart(exitCode: number | null): void {
  if (shuttingDown || restartTimer) return;
  const delay = restartDelayMs(restartAttempts++);
  setStatus('offline', `Printer engine stopped${exitCode == null ? '' : ` (code ${exitCode})`}. Retrying automatically in ${Math.ceil(delay / 1_000)} seconds.`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void startAgent();
  }, delay);
}

async function startAgent({ resetRestartAttempts = false }: { resetRestartAttempts?: boolean } = {}): Promise<void> {
  if (resetRestartAttempts) restartAttempts = 0;
  cancelScheduledRestart();
  stopAgent();
  const config = await loadConfig();
  if (!config) {
    setStatus('setup_required', 'Open Computers to connect this Windows PC to your shop.');
    return;
  }

  setStatus('connecting', config.mode === 'simulate' ? 'Starting safe printer simulation…' : 'Connecting to installed Windows printers…');
  const agentScript = path.join(currentDir, 'index.js');
  const spawned = spawn(process.execPath, [agentScript, ...(config.mode === 'simulate' ? ['--simulate'] : [])], {
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PRINTQ_API_URL: config.apiUrl,
      PRINTQ_AGENT_TOKEN: config.token,
      PRINTQ_AGENT_MODE: config.mode,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  agentProcess = spawned;

  const consume = (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) {
      if (line.includes('Connected to PrintQ')) {
        restartAttempts = 0;
        setStatus('online', config.mode === 'simulate' ? 'Printer simulator connected and ready.' : 'Printer engine connected and ready.');
      } else if (line.includes('printer(s) found')) {
        restartAttempts = 0;
        setStatus('online', line.trim());
      }
      else if (/failed|error/i.test(line)) setStatus('error', line.trim().slice(0, 240));
    }
  };
  spawned.stdout?.on('data', consume);
  spawned.stderr?.on('data', consume);
  spawned.on('exit', (code) => {
    // A manual restart replaces the process before its exit event arrives.
    if (agentProcess !== spawned) return;
    agentProcess = null;
    scheduleRestart(code);
  });
  spawned.on('error', (error) => setStatus('error', error.message));
}

function isAllowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'file:') return true;
    if (url.origin === productionWebUrl || url.origin === 'https://www.printqs.com') return true;
    return (url.hostname === 'localhost' || url.hostname === '127.0.0.1') && (url.protocol === 'http:' || url.protocol === 'https:');
  } catch {
    return false;
  }
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame || !isAllowedUrl(event.senderFrame.url)) {
    throw new Error('This action is only available inside the PrintQs Shop app.');
  }
}

async function loadDashboard(window: BrowserWindow): Promise<void> {
  const base = await dashboardUrl();
  try {
    await window.loadURL(`${base}/dashboard`);
  } catch {
    await window.loadFile(path.join(app.getAppPath(), 'desktop.html'));
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    title: 'PrintQs Shop',
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktopPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedUrl(url)) void window.loadURL(url);
    else void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  window.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    window.setTitle('PrintQs Shop');
  });
  void loadDashboard(window);
  window.once('ready-to-show', () => window.show());
  window.on('close', (event) => {
    if (!shuttingDown) {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function createTray(): Tray {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'printqs-icon.png')
    : path.join(app.getAppPath(), '..', 'web', 'public', 'icons', 'icon-512.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 20, height: 20 });
  const value = new Tray(icon);
  value.setToolTip('PrintQs Shop');
  value.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open shop dashboard', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { label: 'Restart printer engine', click: () => void startAgent({ resetRestartAttempts: true }) },
    { type: 'separator' },
    { label: 'Quit PrintQs Shop', click: () => { shuttingDown = true; app.quit(); } },
  ]));
  value.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
  return value;
}

ipcMain.handle('agent:load', async (event) => {
  assertTrustedSender(event);
  return { config: publicConfig(await loadConfig()), status, appVersion: app.getVersion() };
});
ipcMain.handle('agent:configure', async (event, input: Partial<DesktopConfig>) => {
  assertTrustedSender(event);
  const apiUrl = String(input.apiUrl ?? '').trim().replace(/\/$/, '');
  const webUrl = String(input.webUrl ?? productionWebUrl).trim().replace(/\/$/, '');
  const token = String(input.token ?? '').trim();
  const validLocalApi = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(apiUrl);
  if (!apiUrl.startsWith('https://') && !validLocalApi) throw new Error('The PrintQs API must use HTTPS.');
  if (!isAllowedUrl(webUrl)) throw new Error('Invalid PrintQs dashboard URL.');
  if (token.length < 20) throw new Error('The secure computer token is incomplete.');
  const config: DesktopConfig = { apiUrl, webUrl, token, mode: input.mode === 'simulate' ? 'simulate' : 'real' };
  const stored = toStoredDesktopConfig(config, secureStorage);
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), JSON.stringify(stored, null, 2), { mode: 0o600 });
  await startAgent();
  return { ok: true, config: publicConfig(config), status };
});
ipcMain.handle('agent:restart', async (event) => {
  assertTrustedSender(event);
  await startAgent({ resetRestartAttempts: true });
  return status;
});
ipcMain.handle('agent:open-dashboard', async (event) => {
  assertTrustedSender(event);
  if (mainWindow) await loadDashboard(mainWindow);
});

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.printqs.shop');
    app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true });
    mainWindow = createWindow();
    tray = createTray();
    await startAgent();
  });
  app.on('before-quit', () => { shuttingDown = true; cancelScheduledRestart(); stopAgent(); });
  app.on('window-all-closed', () => undefined);
}
