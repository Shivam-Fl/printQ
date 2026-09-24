import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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
  mediaConfig: Record<string, DriverMedia>;
  lastTestedAt: string | null;
  lastTestStatus: 'requested' | 'spool_accepted' | 'failed' | null;
  lastTestError: string | null;
}

interface DriverMedia {
  paperSize: string;
  bin?: string | null;
}

interface DetectedPrinter {
  name: string;
  paperSizes: string[];
}

interface AgentRow {
  id: string;
  machineLabel: string;
  status: 'online' | 'offline';
  connectedPrinterIds: string[];
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
  const [editingMedia, setEditingMedia] = useState<string | null>(null);
  const [mediaDraft, setMediaDraft] = useState<Record<string, DriverMedia>>({});
  const [testing, setTesting] = useState<string | null>(null);
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
    const onTestResult = () => void refresh();
    socket.on('agent:printers_detected', onDetected);
    socket.on('printer:test_result', onTestResult);
    return () => {
      socket.off('agent:printers_detected', onDetected);
      socket.off('printer:test_result', onTestResult);
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
      const paperSizesLoaded = guessPaperSizes(d.paperSizes);
      await api('/api/shop/printers', {
        method: 'POST',
        role: 'shop',
        body: {
          label: d.name,
          osPrinterName: d.name,
          paperSizesLoaded,
          mediaConfig: Object.fromEntries(paperSizesLoaded.map((size) => [size, { paperSize: size, bin: null }])),
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
      await api('/api/shop/printers', {
        method: 'POST',
        role: 'shop',
        body: {
          ...form,
          mediaConfig: Object.fromEntries(form.paperSizesLoaded.map((size) => [size, { paperSize: size, bin: null }])),
        },
      });
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

  function beginMediaEdit(printer: Printer) {
    setEditingMedia(printer.id);
    setMediaDraft(Object.fromEntries(printer.paperSizesLoaded.map((paper) => [
      paper,
      printer.mediaConfig?.[paper] ?? { paperSize: paper, bin: null },
    ])));
  }

  function updateMedia(paper: string, patch: Partial<DriverMedia>) {
    setMediaDraft((current) => ({
      ...current,
      [paper]: { ...(current[paper] ?? { paperSize: paper, bin: null }), ...patch },
    }));
  }

  async function saveMedia(id: string) {
    try {
      await api(`/api/shop/printers/${id}`, {
        method: 'PATCH',
        role: 'shop',
        body: { mediaConfig: mediaDraft },
      });
      setEditingMedia(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save paper and tray mapping');
    }
  }

  function testAgents(printerId: string) {
    return agents.filter((agent) => agent.status === 'online' && agent.connectedPrinterIds.includes(printerId));
  }

  async function testPrinter(printer: Printer, agentId?: string) {
    setTesting(printer.id);
    setError('');
    try {
      const result = await api<{ message: string }>(`/api/shop/printers/${printer.id}/test-print`, {
        method: 'POST',
        role: 'shop',
        body: agentId ? { agentId } : {},
      });
      setError(result.message);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the printer test page');
    } finally {
      setTesting(null);
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

      <div className="page-heading">
        <div>
          <span className="eyebrow-label">Hardware</span>
          <h1>Printers</h1>
          <p>Match each physical printer to what it can produce. PrintQ uses these details to prevent impossible orders.</p>
        </div>
        <Link className="button-link secondary" to="/dashboard/agents">Connected computers</Link>
      </div>

      {shop && (
        <div className="automation-panel">
          <div style={{ flex: 1, minWidth: 220 }}>
            <strong>Auto-assign printers</strong>
            <p className="dim" style={{ margin: '4px 0 0' }}>
              Recommended: after counter-code verification, send each job to the fastest compatible online printer.
            </p>
          </div>
          <button className={`toggle-button ${shop.autoAssignEnabled ? 'on' : ''}`} onClick={toggleAutoAssign}>
            <span aria-hidden /> {shop.autoAssignEnabled ? 'On' : 'Off'}
          </button>
        </div>
      )}

      <div className="section-heading">
        <div><h2>Detected printers</h2><p>Printers reported by your connected counter computers.</p></div>
        {unlinkedDetected.length > 0 && <span className="summary-pill">{unlinkedDetected.length} ready to add</span>}
      </div>
      {unlinkedDetected.length === 0 ? (
        <div className="empty-state">
          <strong>No unlinked printers found</strong>
          <p>Connect a counter computer first. Any installed printer will appear here automatically.</p>
          <Link className="button-link secondary" to="/dashboard/agents" style={{ marginTop: 16 }}>Connect a computer</Link>
        </div>
      ) : (
        <div className="detected-grid">
          {unlinkedDetected.map((d) => (
            <div key={d.name} className="detected-card">
              <div>
                <span className="detected-icon" aria-hidden>OS</span>
                <strong>{d.name}</strong>
                <p>{d.paperSizes.length > 0 ? `Driver reports ${d.paperSizes.join(', ')}` : 'Detected on a connected computer'}</p>
              </div>
              <button className="small" onClick={() => addDetected(d)}>Add & configure</button>
            </div>
          ))}
        </div>
      )}

      <div className="section-heading">
        <div><h2>Configured printers</h2><p>Capability and live availability used for routing.</p></div>
        <button className="small" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close form' : '+ Add manually'}
        </button>
      </div>

      {showForm && (
        <div className="printer-form stack">
          <div className="checkout-card-head"><h2>Add a printer profile</h2><p>
            Only needed for a printer the agent hasn't detected yet (e.g. it's not connected to this PC).
            You can link it to a real printer later once it's detected.
          </p></div>
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

      <div className="table-shell printer-table">
        <table>
          <thead>
            <tr><th>Label</th><th>Paper</th><th>Colour</th><th>Finishing</th><th>Speed</th><th>Linked printer</th><th>Driver media</th><th>Test page</th><th>Status</th></tr>
          </thead>
          <tbody>
            {printers.length === 0 && (
              <tr><td colSpan={9}><div className="table-empty"><strong>No printers configured</strong><span>Add a detected printer above to start taking orders.</span></div></td></tr>
            )}
            {printers.map((p) => (
              <Fragment key={p.id}>
                <tr>
                  <td>{p.label}</td>
                  <td className="mono">{p.paperSizesLoaded.join(', ')}</td>
                  <td>{p.colorSupport ? 'Yes' : 'B/W'}</td>
                  <td>{p.finishingOptions.map((f) => f.replace('_', ' ')).join(', ') || 'Manual'}</td>
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
                      <span className="stamp red">Not linked</span>
                    )}
                  </td>
                  <td><button className="ghost small" onClick={() => beginMediaEdit(p)}>Configure</button></td>
                  <td>
                    {!p.osPrinterName ? (
                      <span className="dim">Link a Windows printer first</span>
                    ) : testAgents(p.id).length === 0 ? (
                      <span className="dim">Connect an online computer</span>
                    ) : testAgents(p.id).length === 1 ? (
                      <button className="ghost small" disabled={testing === p.id} onClick={() => void testPrinter(p)}>
                        {testing === p.id ? 'Sending…' : 'Print test page'}
                      </button>
                    ) : (
                      <select
                        aria-label={`Choose computer for ${p.label} test page`}
                        defaultValue=""
                        disabled={testing === p.id}
                        onChange={(event) => event.target.value && void testPrinter(p, event.target.value)}
                      >
                        <option value="">Print via computer…</option>
                        {testAgents(p.id).map((agent) => <option key={agent.id} value={agent.id}>{agent.machineLabel}</option>)}
                      </select>
                    )}
                    {p.lastTestStatus === 'requested' && <p className="dim" style={{ margin: '6px 0 0' }}>Waiting for spooler…</p>}
                    {p.lastTestStatus === 'spool_accepted' && <p className="dim" style={{ margin: '6px 0 0' }}>Spool accepted — inspect page</p>}
                    {p.lastTestStatus === 'failed' && <p className="dim" style={{ margin: '6px 0 0' }}>Test failed: {p.lastTestError || 'retry after checking the printer'}</p>}
                  </td>
                  <td>
                    <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} style={{ width: 120 }}>
                      <option value="online">online</option>
                      <option value="offline">offline</option>
                      <option value="jammed">jammed</option>
                    </select>
                  </td>
                </tr>
                {editingMedia === p.id && (
                  <tr className="media-config-row">
                    <td colSpan={9}>
                      <div className="manual-picker">
                        <strong>Windows paper and tray mapping</strong>
                        <p>Map each shop paper option to the exact size and optional tray name shown by this printer’s Windows driver.</p>
                        <div className="stack">
                          {p.paperSizesLoaded.map((paper) => (
                            <div className="form-row align-end" key={paper}>
                              <div className="field" style={{ minWidth: 130 }}><label>Shop option</label><strong>{paper}</strong></div>
                              <div className="field grow">
                                <label htmlFor={`paper-size-${p.id}-${paper}`}>Driver paper size</label>
                                <input id={`paper-size-${p.id}-${paper}`} value={mediaDraft[paper]?.paperSize ?? paper} onChange={(e) => updateMedia(paper, { paperSize: e.target.value })} placeholder="A4" />
                              </div>
                              <div className="field grow">
                                <label htmlFor={`paper-bin-${p.id}-${paper}`}>Tray / bin (optional)</label>
                                <input id={`paper-bin-${p.id}-${paper}`} value={mediaDraft[paper]?.bin ?? ''} onChange={(e) => updateMedia(paper, { bin: e.target.value || null })} placeholder="Tray 2" />
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="row">
                          <button disabled={Object.values(mediaDraft).some((media) => !media.paperSize.trim())} onClick={() => saveMedia(p.id)}>Save mapping</button>
                          <button className="ghost" onClick={() => setEditingMedia(null)}>Cancel</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
