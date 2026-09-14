import { useCallback, useEffect, useState } from 'react';
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

const windowsDownloadUrl =
  'https://github.com/Shivam-Fl/printqs-desktop/releases/latest/download/PrintQs-Shop-Setup.exe';

export default function Agents() {
  const navigate = useNavigate();
  const desktop = window.printqsDesktop;
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [label, setLabel] = useState('Counter PC');
  const [mode, setMode] = useState<'real' | 'simulate'>('real');
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [desktopConfigured, setDesktopConfigured] = useState(false);
  const [desktopStatus, setDesktopStatus] = useState<PrintQsDesktopStatus | null>(null);
  const [appVersion, setAppVersion] = useState('');
  const [showReconnect, setShowReconnect] = useState(false);
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
    if (!desktop) return;
    let mounted = true;
    void desktop.load().then((result) => {
      if (!mounted) return;
      setDesktopConfigured(result.config.configured);
      setMode(result.config.mode);
      setDesktopStatus(result.status);
      setAppVersion(result.appVersion);
    }).catch((err) => setError(err instanceof Error ? err.message : 'Could not read desktop status'));
    const unsubscribe = desktop.onStatus((next) => {
      if (mounted) setDesktopStatus(next);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [desktop]);

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

  async function connectThisComputer() {
    if (!desktop) return;
    setBusy(true);
    setError('');
    let createdAgentId: string | null = null;
    try {
      const result = await api<{ token: string; agent: { id: string } }>('/api/shop/agents', {
        method: 'POST',
        role: 'shop',
        body: { machineLabel: label.trim(), connectedPrinterIds: [] },
      });
      createdAgentId = result.agent.id;
      setNewAgentId(result.agent.id);
      const next = await desktop.configure({
        apiUrl: API_URL || window.location.origin,
        webUrl: window.location.origin,
        token: result.token,
        mode,
      });
      setDesktopStatus(next.status);
      setDesktopConfigured(true);
      setShowReconnect(false);
      await refresh();
    } catch (err) {
      if (createdAgentId) {
        await api(`/api/shop/agents/${createdAgentId}`, { method: 'DELETE', role: 'shop' }).catch(() => undefined);
        setNewAgentId(null);
      }
      setError(err instanceof Error ? err.message : 'Could not connect this computer');
    } finally {
      setBusy(false);
    }
  }

  async function restartDesktopEngine() {
    if (!desktop) return;
    setError('');
    try {
      setDesktopStatus(await desktop.restart());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart the printer engine');
    }
  }

  async function removeAgent(id: string) {
    if (!confirm('Remove this computer from PrintQs? Jobs will no longer be sent to printers reached through it.')) return;
    try {
      await api(`/api/shop/agents/${id}`, { method: 'DELETE', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove computer');
    }
  }

  const waitingAgent = agents.find((agent) => agent.id === newAgentId);
  const showConnectionForm = Boolean(desktop) && (!desktopConfigured || showReconnect);

  return (
    <div className="page wide shop-page">
      <ShopNav />
      <header className="page-heading">
        <div>
          <span className="eyebrow-label">Local printer control</span>
          <h1>Shop computers</h1>
          <p>The PrintQs Shop app securely links this dashboard to printers installed on each Windows counter PC.</p>
        </div>
        <span className="summary-pill">{agents.filter((agent) => agent.status === 'online').length} online</span>
      </header>

      {!desktop && (
        <section className="connect-panel">
          <div className="connect-intro">
            <span className="step-number">01</span>
            <div>
              <h2>Open this dashboard in PrintQs Shop</h2>
              <p>The desktop app includes this complete dashboard plus printer discovery, automatic printing, startup and health monitoring. Browser-only mode cannot directly control Windows printers.</p>
            </div>
          </div>
          <a className="button-link" href={windowsDownloadUrl}>Download PrintQs Shop for Windows</a>
        </section>
      )}

      {desktop && desktopStatus && (
        <section className={`notice desktop-engine-notice ${desktopStatus.state === 'online' ? 'success-notice' : ''}`}>
          <div>
            <strong>Printer engine: {desktopStatus.state.replace('_', ' ')}</strong>
            <p>{desktopStatus.detail}{appVersion ? ` · App v${appVersion}` : ''}</p>
          </div>
          <div className="row">
            {desktopConfigured && <button className="ghost small" onClick={restartDesktopEngine}>Restart engine</button>}
            {desktopConfigured && <button className="ghost small" onClick={() => setShowReconnect((value) => !value)}>Reconnect</button>}
          </div>
        </section>
      )}

      {showConnectionForm && !newAgentId && (
        <section className="connect-panel">
          <div className="connect-intro">
            <span className="step-number">01</span>
            <div>
              <h2>Connect this Windows computer</h2>
              <p>PrintQs will securely register this app, detect installed printers and keep the engine running in the system tray.</p>
            </div>
          </div>
          <div className="mode-cards" role="radiogroup" aria-label="Printer mode">
            <button className={`mode-card${mode === 'real' ? ' selected' : ''}`} onClick={() => setMode('real')}>
              <strong>Real printers</strong>
              <span>Detect and use devices installed on this PC</span>
            </button>
            <button className={`mode-card${mode === 'simulate' ? ' selected' : ''}`} onClick={() => setMode('simulate')}>
              <strong>Safe simulator</strong>
              <span>Test full print flows without physical hardware</span>
            </button>
          </div>
          <div className="form-row align-end">
            <div className="field grow">
              <label htmlFor="machine-label">Computer name</label>
              <input id="machine-label" value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Counter PC" />
            </div>
            <button disabled={busy || !label.trim()} onClick={connectThisComputer}>
              {busy ? 'Connecting securely…' : 'Connect this computer'}
            </button>
          </div>
        </section>
      )}

      {desktop && newAgentId && (
        <section className="connection-wizard">
          <div className="wizard-header">
            <div>
              <span className="eyebrow-label">Automatic setup</span>
              <h2>{mode === 'simulate' ? 'Printer simulator' : 'Windows printer engine'}</h2>
              <p>No command, token copy or separate agent installation is required.</p>
            </div>
            <span className={`status-dot${waitingAgent?.status === 'online' || desktopStatus?.state === 'online' ? ' done' : ''}`}>
              {waitingAgent?.status === 'online' || desktopStatus?.state === 'online' ? 'Connected' : 'Connecting'}
            </span>
          </div>
          {(waitingAgent?.status === 'online' || desktopStatus?.state === 'online') && (
            <div className="notice success-notice compact">
              <div>
                <strong>This computer is ready</strong>
                <p>{waitingAgent?.detectedPrinters?.length
                  ? `${waitingAgent.detectedPrinters.length} printer${waitingAgent.detectedPrinters.length === 1 ? '' : 's'} detected.`
                  : mode === 'simulate' ? 'The safe printer simulator is connected.' : 'Scanning Windows for installed printers.'}</p>
              </div>
              <Link className="button-link" to="/dashboard/printers">Configure printers</Link>
            </div>
          )}
          <button className="text-button" onClick={() => setNewAgentId(null)}>Close setup</button>
        </section>
      )}

      <section>
        <div className="section-heading">
          <div><h2>Registered computers</h2><p>A computer shows offline after two minutes without a heartbeat.</p></div>
        </div>

        {agents.length === 0 ? (
          <div className="empty-state">
            <strong>No computers connected yet</strong>
            <p>{desktop ? 'Connect this Windows PC above to discover its printers.' : 'Install PrintQs Shop on a counter PC, sign in, then connect it here.'}</p>
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
