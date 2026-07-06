import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

interface AgentRow {
  id: string;
  machineLabel: string;
  connectedPrinterIds: string[];
  lastHeartbeatAt: string | null;
  status: 'online' | 'offline';
}

interface Printer {
  id: string;
  label: string;
}

export default function Agents() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [label, setLabel] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api<{ agents: AgentRow[] }>('/api/shop/agents', { role: 'shop' }),
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
      ]);
      setAgents(a.agents);
      setPrinters(p.printers);
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

  async function register() {
    setError('');
    try {
      const res = await api<{ token: string }>('/api/shop/agents', {
        method: 'POST',
        role: 'shop',
        body: { machineLabel: label, connectedPrinterIds: selected },
      });
      setNewToken(res.token);
      setLabel('');
      setSelected([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register agent');
    }
  }

  const printerLabel = (id: string) => printers.find((p) => p.id === id)?.label ?? id.slice(0, 8);

  return (
    <div className="page wide">
      <Topbar tag="agents" right={<Link to="/dashboard">← Dashboard</Link>} />
      <p className="dim">
        An agent is the small PrintQ program on a shop PC that actually sends jobs to your printers.
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
            On the shop PC: set PRINTQ_AGENT_TOKEN to this value, map printers via PRINTER_MAP, then
            start the agent.
          </p>
          <button className="ghost small" onClick={() => setNewToken(null)}>
            Done, I copied it
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
        <div>
          <label>Printers this PC can reach</label>
          <div className="row">
            {printers.map((p) => (
              <button
                key={p.id}
                className={`chip ${selected.includes(p.id) ? 'on' : ''}`}
                onClick={() =>
                  setSelected((s) => (s.includes(p.id) ? s.filter((x) => x !== p.id) : [...s, p.id]))
                }
              >
                {p.label}
              </button>
            ))}
            {printers.length === 0 && (
              <span className="dim">
                Add printers first — <Link to="/dashboard/printers">Printers page</Link>
              </span>
            )}
          </div>
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
            <tr><th>Machine</th><th>Printers</th><th>Last heartbeat</th><th>Status</th></tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr><td colSpan={4} className="dim">No agents yet</td></tr>
            )}
            {agents.map((a) => (
              <tr key={a.id}>
                <td>{a.machineLabel}</td>
                <td>{a.connectedPrinterIds.map(printerLabel).join(', ') || '—'}</td>
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
