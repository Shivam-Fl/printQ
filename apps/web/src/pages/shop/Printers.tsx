import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken } from '../../api.js';
import { getShopSocket } from '../../socket.js';
import ShopNav from '../../components/ShopNav.js';

interface Printer {
  id: string;
  label: string;
  paperSizesLoaded: string[];
  colorSupport: boolean;
  finishingOptions: string[];
  avgPagesPerMinute: number;
  status: 'online' | 'offline' | 'jammed';
  osPrinterName: string | null;
}

interface DetectedPrinter {
  name: string;
  paperSizes: string[];
}

interface AgentRow {
  id: string;
  machineLabel: string;
  detectedPrinters: DetectedPrinter[] | null;
}

interface ShopSettings {
  autoAssignEnabled: boolean;
  name: string;
  slug?: string;
}

const EMPTY_FORM = {
  label: '',
  paperSizesLoaded: ['A4'] as string[],
  colorSupport: false,
  finishingOptions: [] as string[],
  avgPagesPerMinute: 15,
};

/** Best-effort A4/A3 guess from what the OS driver reports. */
function guessPaperSizes(reported: string[]): string[] {
  const has = (needle: string) => reported.some((s) => s.toLowerCase().includes(needle));
  const sizes: string[] = [];
  if (has('a3')) sizes.push('A3');
  if (sizes.length === 0 || has('a4') || has('letter')) sizes.unshift('A4');
  return sizes.length ? sizes : ['A4'];
}

export default function Printers() {
  const navigate = useNavigate();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [shop, setShop] = useState<ShopSettings | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [linking, setLinking] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [p, a, s] = await Promise.all([
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
        api<{ agents: AgentRow[] }>('/api/shop/agents', { role: 'shop' }),
        api<{ shop: ShopSettings }>('/api/shop/me', { role: 'shop' }),
      ]);
      setPrinters(p.printers);
      setAgents(a.agents);
      setShop(s.shop);
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
    return () => {
      socket.off('agent:printers_detected', onDetected);
    };
  }, [refresh]);

  // every OS printer any of this shop's agents can currently see, minus ones already linked
  const unlinkedDetected = useMemo(() => {
    const linked = new Set(printers.map((p) => p.osPrinterName).filter(Boolean));
    const byName = new Map<string, DetectedPrinter>();
    for (const a of agents) {
      for (const d of a.detectedPrinters ?? []) {
        if (!linked.has(d.name)) byName.set(d.name, d);
      }
    }
    return [...byName.values()];
  }, [agents, printers]);

  async function toggleAutoAssign() {
    if (!shop) return;
    try {
      await api('/api/shop/me', {
        method: 'PATCH',
        role: 'shop',
        body: { autoAssignEnabled: !shop.autoAssignEnabled },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Only the owner can change this');
    }
  }

  async function addDetected(d: DetectedPrinter) {
    try {
      await api('/api/shop/printers', {
        method: 'POST',
        role: 'shop',
        body: {
          label: d.name,
          osPrinterName: d.name,
          paperSizesLoaded: guessPaperSizes(d.paperSizes),
          colorSupport: false,
          finishingOptions: [],
          avgPagesPerMinute: 15,
        },
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add printer');
    }
  }

  async function addPrinter() {
    try {
      await api('/api/shop/printers', { method: 'POST', role: 'shop', body: form });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add printer');
    }
  }

  async function linkPrinter(id: string, osPrinterName: string) {
    try {
      await api(`/api/shop/printers/${id}`, { method: 'PATCH', role: 'shop', body: { osPrinterName } });
      setLinking(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link printer');
    }
  }

  async function setStatus(id: string, status: string) {
    try {
      await api(`/api/shop/printers/${id}`, { method: 'PATCH', role: 'shop', body: { status } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  }

  function toggleInList(key: 'paperSizesLoaded' | 'finishingOptions', value: string) {
    setForm((f) => {
      const list = f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value];
      return { ...f, [key]: list };
    });
  }

  return (
    <div className="page wide">
      <ShopNav />

      {shop && (
        <div className="card row between">
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>Auto-assign printers</strong>
            <p className="dim" style={{ margin: '4px 0 0' }}>
              On: the OTP sends the job straight to the best printer. Off: you confirm from a dropdown
              every time.
            </p>
          </div>
          <button className={shop.autoAssignEnabled ? '' : 'ghost'} onClick={toggleAutoAssign}>
            {shop.autoAssignEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
      )}

      <div className="row between">
        <h2>Printers found on your PCs {unlinkedDetected.length > 0 ? `(${unlinkedDetected.length})` : ''}</h2>
      </div>
      {unlinkedDetected.length === 0 ? (
        <div className="card">
          <p className="dim" style={{ margin: 0 }}>
            None yet. Start the print agent on a shop PC —{' '}
            <a href="#agents-hint">see the Agents page</a> — and any printer it can see will show up
            here automatically, ready to add with one click.
          </p>
        </div>
      ) : (
        <div className="stack">
          {unlinkedDetected.map((d) => (
            <div key={d.name} className="card row between">
              <div>
                <strong>{d.name}</strong>
                <p className="dim" style={{ margin: '2px 0 0' }}>Detected on this shop's PC</p>
              </div>
              <button onClick={() => addDetected(d)}>+ Add this printer</button>
            </div>
          ))}
        </div>
      )}

      <div className="row between">
        <h2>Printers ({printers.length})</h2>
        <button className="small" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : '+ Add manually'}
        </button>
      </div>

      {showForm && (
        <div className="card stack">
          <p className="dim" style={{ margin: 0 }}>
            Only needed for a printer the agent hasn't detected yet (e.g. it's not connected to this PC).
            You can link it to a real printer later once it's detected.
          </p>
          <div>
            <label htmlFor="plabel">Label</label>
            <input
              id="plabel"
              type="text"
              placeholder='e.g. "Printer 1 — near entrance"'
              value={form.label}
              onChange={(e) => setForm({ ...form, label: e.target.value })}
            />
          </div>
          <div>
            <label>Loads paper / can do</label>
            <div className="row">
              {['A4', 'A3'].map((size) => (
                <button
                  key={size}
                  className={`chip ${form.paperSizesLoaded.includes(size) ? 'on' : ''}`}
                  onClick={() => toggleInList('paperSizesLoaded', size)}
                >
                  {size}
                </button>
              ))}
              <button
                className={`chip ${form.colorSupport ? 'on' : ''}`}
                onClick={() => setForm({ ...form, colorSupport: !form.colorSupport })}
              >
                Colour
              </button>
              {['stapling', 'spiral_binding'].map((f) => (
                <button
                  key={f}
                  className={`chip ${form.finishingOptions.includes(f) ? 'on' : ''}`}
                  onClick={() => toggleInList('finishingOptions', f)}
                >
                  {f.replace('_', ' ')}
                </button>
              ))}
            </div>
          </div>
          <div style={{ maxWidth: 200 }}>
            <label htmlFor="ppm">Pages per minute</label>
            <input
              id="ppm"
              type="number"
              min={1}
              max={200}
              value={form.avgPagesPerMinute}
              onChange={(e) => setForm({ ...form, avgPagesPerMinute: Number(e.target.value) || 15 })}
            />
          </div>
          <button disabled={!form.label || form.paperSizesLoaded.length === 0} onClick={addPrinter}>
            Add printer
          </button>
        </div>
      )}

      <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
        <table>
          <thead>
            <tr><th>Label</th><th>Paper</th><th>Colour</th><th>Finishing</th><th>Speed</th><th>Linked printer</th><th>Status</th></tr>
          </thead>
          <tbody>
            {printers.map((p) => (
              <tr key={p.id}>
                <td>{p.label}</td>
                <td className="mono">{p.paperSizesLoaded.join(', ')}</td>
                <td>{p.colorSupport ? 'Yes' : 'B/W'}</td>
                <td>{p.finishingOptions.map((f) => f.replace('_', ' ')).join(', ') || '—'}</td>
                <td className="mono">{p.avgPagesPerMinute} ppm</td>
                <td>
                  {p.osPrinterName ? (
                    <span className="mono">{p.osPrinterName}</span>
                  ) : linking === p.id ? (
                    <select
                      autoFocus
                      value=""
                      onChange={(e) => e.target.value && void linkPrinter(p.id, e.target.value)}
                      onBlur={() => setLinking(null)}
                    >
                      <option value="">Pick a detected printer…</option>
                      {unlinkedDetected.map((d) => (
                        <option key={d.name} value={d.name}>{d.name}</option>
                      ))}
                    </select>
                  ) : unlinkedDetected.length > 0 ? (
                    <button className="ghost small" onClick={() => setLinking(p.id)}>Link…</button>
                  ) : (
                    <span className="dim">not linked</span>
                  )}
                </td>
                <td>
                  <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} style={{ width: 120 }}>
                    <option value="online">online</option>
                    <option value="offline">offline</option>
                    <option value="jammed">jammed</option>
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
