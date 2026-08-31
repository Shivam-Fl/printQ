import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_URL, api, getToken } from '../../api.js';
import { getShopSocket } from '../../socket.js';
import ShopNav from '../../components/ShopNav.js';

interface DetectedPrinter {
  name: string;
  paperSizes: string[];
}

interface AgentRow {
  id: string;
  machineLabel: string;
  connectedPrinterIds: string[];
  lastHeartbeatAt: string | null;
  status: 'online' | 'offline';
  detectedPrinters: DetectedPrinter[] | null;
  detectedAt: string | null;
}

export default function Agents() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [label, setLabel] = useState('Counter PC');
  const [mode, setMode] = useState<'real' | 'simulate'>('real');
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ agents: AgentRow[] }>('/api/shop/agents', { role: 'shop' });
      setAgents(result.agents);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate('/dashboard/login');
      else setError(err instanceof Error ? err.message : 'Failed to load computers');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    void refresh();
  }, [refresh, navigate]);

  useEffect(() => {
    const socket = getShopSocket();
    if (!socket) return;
    const onDetected = () => void refresh();
    socket.on('agent:printers_detected', onDetected);
    socket.on('agent:offline', onDetected);
    const interval = newAgentId ? setInterval(() => void refresh(), 2500) : undefined;
    return () => {
      socket.off('agent:printers_detected', onDetected);
      socket.off('agent:offline', onDetected);
      if (interval) clearInterval(interval);
    };
  }, [refresh, newAgentId]);

  async function register() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string; agent: { id: string } }>('/api/shop/agents', {
        method: 'POST',
        role: 'shop',
        body: { machineLabel: label.trim(), connectedPrinterIds: [] },
      });
      setNewToken(result.token);
      setNewAgentId(result.agent.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register this computer');
    } finally {
      setBusy(false);
    }
  }

  async function removeAgent(id: string) {
    if (!confirm('Remove this computer from PrintQ?')) return;
    try {
      await api(`/api/shop/agents/${id}`, { method: 'DELETE', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove computer');
    }
  }

  const waitingAgent = agents.find((agent) => agent.id === newAgentId);
  const apiUrl = API_URL || window.location.origin;
  const startCommand = useMemo(() => {
    if (!newToken) return '';
    const simulationLine = mode === 'simulate' ? `$env:PRINTQ_AGENT_MODE = "simulate"\n` : '';
    return `$env:PRINTQ_API_URL = "${apiUrl}"\n$env:PRINTQ_AGENT_TOKEN = "${newToken}"\n${simulationLine}npm run dev:agent`;
  }, [apiUrl, mode, newToken]);

  function downloadSetupScript() {
    if (!newToken) return;
    const safe = (value: string) => value.replace(/'/g, "''");
    const archiveUrl = `${window.location.origin}/downloads/printq-agent.tgz`;
    const modeArgument = mode === 'simulate' ? '--simulate' : '';
    const script = `$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host 'Node.js LTS is required. Install it from https://nodejs.org and run this setup again.' -ForegroundColor Yellow
  Start-Process 'https://nodejs.org/en/download'
  Read-Host 'Press Enter to close'
  exit 1
}
$installDir = Join-Path $env:LOCALAPPDATA 'PrintQ Agent'
$archive = Join-Path $env:TEMP 'printq-agent.tgz'
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
Invoke-WebRequest -Uri '${safe(archiveUrl)}' -OutFile $archive
& npm.cmd install --prefix $installDir $archive --omit=dev
$launcher = Join-Path $installDir 'Start PrintQ Agent.cmd'
$lines = @(
  '@echo off',
  'set PRINTQ_API_URL=${safe(apiUrl)}',
  'set PRINTQ_AGENT_TOKEN=${safe(newToken)}',
  'set PRINTQ_AGENT_MODE=${mode}',
  '"' + $node.Source + '" "' + (Join-Path $installDir 'node_modules\\@printq\\agent\\dist\\index.js') + '" ${modeArgument}'
)
Set-Content -LiteralPath $launcher -Value $lines -Encoding Ascii
$startup = [Environment]::GetFolderPath('Startup')
Copy-Item -LiteralPath $launcher -Destination (Join-Path $startup 'PrintQ Agent.cmd') -Force
Start-Process -FilePath $launcher -WindowStyle Hidden
Write-Host 'PrintQ Agent installed and started. You can close this window.' -ForegroundColor Green
Start-Sleep -Seconds 3
`;
    const blob = new Blob([script], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = mode === 'simulate' ? 'Install-PrintQ-Simulator.ps1' : 'Install-PrintQ-Agent.ps1';
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function copyCommand() {
    await navigator.clipboard.writeText(startCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="page wide shop-page">
      <ShopNav />
      <header className="page-heading">
        <div>
          <span className="eyebrow-label">Printer bridge</span>
          <h1>Connected computers</h1>
          <p>One lightweight agent connects PrintQ to every printer already installed on a Windows PC.</p>
        </div>
        <span className="summary-pill">{agents.filter((agent) => agent.status === 'online').length} online</span>
      </header>

      {!newToken && (
        <section className="connect-panel">
          <div className="connect-intro">
            <span className="step-number">01</span>
            <div>
              <h2>Choose how to connect</h2>
              <p>Use a real counter PC, or run a safe simulator while testing without hardware.</p>
            </div>
          </div>
          <div className="mode-cards" role="radiogroup" aria-label="Agent mode">
            <button className={`mode-card${mode === 'real' ? ' selected' : ''}`} onClick={() => setMode('real')}>
              <strong>Real printer</strong>
              <span>Detect devices installed on this Windows PC</span>
            </button>
            <button className={`mode-card${mode === 'simulate' ? ' selected' : ''}`} onClick={() => setMode('simulate')}>
              <strong>Simulation</strong>
              <span>Complete real orders without sending paper to a printer</span>
            </button>
          </div>
          <div className="form-row align-end">
            <div className="field grow">
              <label htmlFor="machine-label">Computer name</label>
              <input
                id="machine-label"
                type="text"
                placeholder="Counter PC"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
            <button disabled={busy || !label.trim()} onClick={register}>
              {busy ? 'Creating secure link…' : 'Create connection'}
            </button>
          </div>
        </section>
      )}

      {newToken && (
        <section className="connection-wizard">
          <div className="wizard-header">
            <div>
              <span className="eyebrow-label">Secure one-time setup</span>
              <h2>{mode === 'simulate' ? 'Start the printer simulator' : 'Start the agent on your counter PC'}</h2>
            </div>
            <span className={`status-dot${waitingAgent?.status === 'online' ? ' done' : ''}`}>
              {waitingAgent?.status === 'online' ? 'Connected' : 'Waiting'}
            </span>
          </div>

          <ol className="plain-steps">
            <li><span>1</span><div><strong>Download the setup file on this computer</strong><p>It installs the lightweight agent and starts it automatically whenever this Windows account signs in.</p><button onClick={downloadSetupScript}>Download Windows setup</button></div></li>
            <li>
              <span>2</span>
              <div><strong>Run the downloaded PowerShell file</strong><p>Right-click it and choose <em>Run with PowerShell</em>. Node.js LTS is the only prerequisite.</p></div>
            </li>
            <li><span>3</span><div><strong>Wait for “Connected”</strong><p>PrintQ will scan installed printers and show them here automatically.</p></div></li>
          </ol>

          <details className="developer-command">
            <summary>Developer setup command</summary>
            <div className="command-block">
              <code>{startCommand}</code>
              <button className="secondary small" onClick={copyCommand}>{copied ? 'Copied' : 'Copy command'}</button>
            </div>
          </details>

          {waitingAgent?.status === 'online' && (
            <div className="notice success-notice compact">
              <div>
                <strong>Computer connected</strong>
                <p>
                  {waitingAgent.detectedPrinters?.length
                    ? `${waitingAgent.detectedPrinters.length} printer${waitingAgent.detectedPrinters.length === 1 ? '' : 's'} detected.`
                    : 'Waiting for the first printer scan.'}
                </p>
              </div>
              <Link className="button-link" to="/dashboard/printers">Review printers</Link>
            </div>
          )}

          <button className="text-button" onClick={() => { setNewToken(null); setNewAgentId(null); }}>Close setup</button>
        </section>
      )}

      <section>
        <div className="section-heading">
          <div><h2>Registered computers</h2><p>Agents turn red if heartbeats stop for two minutes.</p></div>
        </div>

        {agents.length === 0 ? (
          <div className="empty-state">
            <strong>No computers connected yet</strong>
            <p>Create the first connection above. Your printers will appear automatically.</p>
          </div>
        ) : (
          <div className="device-grid">
            {agents.map((agent) => (
              <article className="device-card" key={agent.id}>
                <div className="device-card-head">
                  <div className={`device-icon${agent.status === 'online' ? ' online' : ''}`} aria-hidden>PC</div>
                  <div className="grow">
                    <strong>{agent.machineLabel}</strong>
                    <p>{agent.lastHeartbeatAt ? `Last seen ${new Date(agent.lastHeartbeatAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Never connected'}</p>
                  </div>
                  <span className={`status-dot${agent.status === 'online' ? ' done' : ''}`}>{agent.status}</span>
                </div>
                <div className="device-printers">
                  <span>Detected printers</span>
                  <strong>{agent.detectedPrinters?.map((printer) => printer.name).join(', ') || 'None reported'}</strong>
                </div>
                <div className="device-actions">
                  <Link to="/dashboard/printers">Manage printers</Link>
                  <button className="text-button danger-text" onClick={() => removeAgent(agent.id)}>Remove</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
