import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getToken } from '../../api.js';
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
  const [label, setLabel] = useState('');
  const [newAgentId, setNewAgentId] = useState<string | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const a = await api<{ agents: AgentRow[] }>('/api/shop/agents', { role: 'shop' });
      setAgents(a.agents);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate('/dashboard/login');
      else setError(err instanceof Error ? err.message : 'Failed to load');
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
    const interval = newAgentId ? setInterval(() => void refresh(), 3000) : undefined;
    return () => {
      socket.off('agent:printers_detected', onDetected);
      if (interval) clearInterval(interval);
    };
  }, [refresh, newAgentId]);

  async function register() {
    setError('');
    try {
      const res = await api<{ token: string; agent: { id: string } }>('/api/shop/agents', {
        method: 'POST',
        role: 'shop',
        body: { machineLabel: label, connectedPrinterIds: [] },
      });
      setNewToken(res.token);
      setNewAgentId(res.agent.id);
      setLabel('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register agent');
    }
  }

  const waitingAgent = agents.find((a) => a.id === newAgentId);

  return (
    <div className="page wide">
      <ShopNav />
      <p className="dim" id="agents-hint">
        An agent is the small PrintQ program on a shop PC that talks to your printers. It finds every
        printer installed on that PC automatically — you never type a printer name.
      </p>

      {newToken && (
        <div className="card stack">
          <span className="stamp yellow">copy this token now — shown only once</span>
          <code
            className="mono"
            style={{
              wordBreak: 'break-all',
              background: 'var(--paper-bg)',
              padding: 12,
              borderRadius: 10,
              border: '1px solid var(--rule)',
            }}
          >
            {newToken}
          </code>
          <p className="dim" style={{ margin: 0 }}>
            On the shop PC: install the agent once, then run it. The first time it starts, it'll ask you
            to paste this token — after that it remembers it, so you just start it the same way every
            time. That's the only setup step; every printer connected to that PC shows up on the{' '}
            <Link to="/dashboard/printers">Printers page</Link> automatically.
          </p>
          {waitingAgent && (waitingAgent.detectedPrinters?.length ?? 0) === 0 && (
            <div className="row" style={{ gap: 8 }}>
              <span className="stamp blue">waiting for this PC to connect…</span>
            </div>
          )}
          {waitingAgent && (waitingAgent.detectedPrinters?.length ?? 0) > 0 && (
            <div className="stack">
              <span className="stamp green">connected — found {waitingAgent.detectedPrinters!.length} printer(s)</span>
              <p className="dim" style={{ margin: 0 }}>
                Go to the <Link to="/dashboard/printers">Printers page</Link> to add them.
              </p>
            </div>
          )}
          <button className="ghost small" onClick={() => { setNewToken(null); setNewAgentId(null); }}>
            Done
          </button>
        </div>
      )}

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Register this PC</h2>
        <div>
          <label htmlFor="mlabel">Machine label</label>
          <input
            id="mlabel"
            type="text"
            placeholder='e.g. "Counter PC"'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <button disabled={!label} onClick={register}>
          Register &amp; get token
        </button>
        {error && <div className="error">{error}</div>}
      </div>

      <h2>Registered agents</h2>
      <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
        <table>
          <thead>
            <tr><th>Machine</th><th>Detected printers</th><th>Last heartbeat</th><th>Status</th></tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr><td colSpan={4} className="dim">No agents yet</td></tr>
            )}
            {agents.map((a) => (
              <tr key={a.id}>
                <td>{a.machineLabel}</td>
                <td>
                  {a.detectedPrinters && a.detectedPrinters.length > 0
                    ? a.detectedPrinters.map((d) => d.name).join(', ')
                    : '—'}
                </td>
                <td className="dim mono">
                  {a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).toLocaleTimeString() : 'never'}
                </td>
                <td>
                  <span className={`stamp ${a.status === 'online' ? 'green' : 'red'}`}>{a.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
