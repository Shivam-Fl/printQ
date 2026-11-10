import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getShopRole, getToken } from '../../api.js';
import { getShopSocket } from '../../socket.js';
import ShopNav from '../../components/ShopNav.js';
import ShopTabs from '../../components/ShopTabs.js';
import { detectedEmptyState, practiceOnly, unlinkedDetectedPrinters, type DetectedPrinterLite } from './printersView.js';
import { shopLoginPath } from '../../lib/locationFlow.js';
import { afterPrinterAdded, isSimulatorPrinterName, type AfterPrinterAdded, type SetupAfterAdd } from './printerAddedNotice.js';
import DetectedPrinters from './DetectedPrinters.js';

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

interface AgentRow {
  id: string;
  machineLabel: string;
  status: 'online' | 'offline';
  connectedPrinterIds: string[];
  detectedPrinters: DetectedPrinterLite[] | null;
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

const STATUS_WORDS: Record<Printer['status'], string> = { online: 'On', offline: 'Off', jammed: 'Jammed' };
const finishingWords = (list: string[]) => list.map((f) => f.replace(/_/g, ' ')).join(', ');

export default function Printers() {
  const navigate = useNavigate();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [shop, setShop] = useState<ShopSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [linking, setLinking] = useState<string | null>(null);
  const [editingMedia, setEditingMedia] = useState<string | null>(null);
  const [mediaDraft, setMediaDraft] = useState<Record<string, DriverMedia>>({});
  const [testing, setTesting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // What adding a printer changed for students ("your shop is live", or what is still missing).
  const [added, setAdded] = useState<AfterPrinterAdded | null>(null);
  const addedRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ label: '', colorSupport: false });
  // From /api/shop/me once loaded (the stored role can be missing on older sessions).
  const [role, setRole] = useState(getShopRole);
  // Printer setup is owner-only on the API; staff can still switch a printer on or off.
  const isOwner = role === 'owner';

  const refresh = useCallback(async () => {
    try {
      const [p, a, s] = await Promise.all([
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
        api<{ agents: AgentRow[] }>('/api/shop/agents', { role: 'shop' }),
        api<{ shop: ShopSettings; user?: { role: 'owner' | 'staff' } }>('/api/shop/me', { role: 'shop' }),
      ]);
      setPrinters(p.printers);
      setAgents(a.agents);
      setShop(s.shop);
      if (s.user) setRole(s.user.role);
      setLoaded(true);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate(shopLoginPath());
      else setError(err instanceof Error ? err.message : 'Could not load printers. Try again.');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(shopLoginPath());
      return;
    }
    void refresh();
  }, [refresh, navigate]);

  useEffect(() => {
    const socket = getShopSocket();
    if (!socket) return;
    const onChange = () => void refresh();
    socket.on('agent:printers_detected', onChange);
    socket.on('printer:test_result', onChange);
    return () => {
      socket.off('agent:printers_detected', onChange);
      socket.off('printer:test_result', onChange);
    };
  }, [refresh]);

  // The notice appears at the top while the owner may be scrolled down at the printer: bring it into view.
  useEffect(() => {
    if (!added) return;
    addedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    addedRef.current?.focus({ preventScroll: true });
  }, [added]);

  const unlinkedDetected = useMemo(() => unlinkedDetectedPrinters(agents, printers), [agents, printers]);

  async function toggleAutoAssign() {
    if (!shop) return;
    try {
      await api('/api/shop/me', { method: 'PATCH', role: 'shop', body: { autoAssignEnabled: !shop.autoAssignEnabled } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Only the owner can change this.');
    }
  }

  /** After a printer is linked, ask the server whether the shop is now live (it publishes itself). */
  async function showWhatChanged(addedName: string) {
    try {
      const { setup } = await api<{ setup: SetupAfterAdd }>('/api/shop/setup-status', { role: 'shop' });
      setAdded(afterPrinterAdded(setup, addedName));
    } catch {
      setAdded(null); // the printer is still added; the list shows it
    }
  }

  async function addPrinter() {
    setError('');
    try {
      await api('/api/shop/printers', {
        method: 'POST',
        role: 'shop',
        body: { ...form, mediaConfig: Object.fromEntries(form.paperSizesLoaded.map((size) => [size, { paperSize: size, bin: null }])) },
      });
      setNotice(`"${form.label}" is saved but gets no orders until it is linked. Install it on your counter PC, then press Link next to it.`);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the printer.');
    }
  }

  /** Send only what changed: staff may change status alone, everything else is owner-only. */
  async function patchPrinter(printer: Printer, changes: Record<string, unknown>) {
    await api(`/api/shop/printers/${printer.id}`, { method: 'PATCH', role: 'shop', body: changes });
  }

  async function linkPrinter(printer: Printer, osPrinterName: string) {
    try {
      await patchPrinter(printer, { osPrinterName });
      setLinking(null);
      setNotice('');
      await Promise.all([refresh(), showWhatChanged(osPrinterName)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link the printer.');
    }
  }

  async function setStatus(printer: Printer, status: string) {
    try {
      await patchPrinter(printer, { status });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the printer.');
    }
  }

  function beginEdit(printer: Printer) {
    setEditingMedia(null);
    setEditing(printer.id);
    setEditDraft({ label: printer.label, colorSupport: printer.colorSupport });
  }

  async function saveEdit(printer: Printer) {
    setError('');
    try {
      await patchPrinter(printer, { label: editDraft.label.trim(), colorSupport: editDraft.colorSupport });
      setEditing(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the printer.');
    }
  }

  async function removePrinter(printer: Printer) {
    const again = printer.osPrinterName ? ' You can add it again from the printers your counter PC found.' : '';
    if (!confirm(`Remove "${printer.label}"? Students will no longer be sent to it.${again}`)) return;
    setError('');
    try {
      await api(`/api/shop/printers/${printer.id}`, { method: 'DELETE', role: 'shop' });
      if (editing === printer.id) setEditing(null);
      setNotice('');
      setAdded(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove the printer.');
    }
  }

  function beginMediaEdit(printer: Printer) {
    setEditing(null);
    setEditingMedia(printer.id);
    setMediaDraft(Object.fromEntries(printer.paperSizesLoaded.map((paper) => [paper, printer.mediaConfig?.[paper] ?? { paperSize: paper, bin: null }])));
  }

  function updateMedia(paper: string, patch: Partial<DriverMedia>) {
    setMediaDraft((current) => ({ ...current, [paper]: { ...(current[paper] ?? { paperSize: paper, bin: null }), ...patch } }));
  }

  async function saveMedia(printer: Printer) {
    try {
      await patchPrinter(printer, { mediaConfig: mediaDraft });
      setEditingMedia(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the paper and tray settings.');
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
      setNotice(result.message);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the test page.');
    } finally {
      setTesting(null);
    }
  }

  const agentsOnline = agents.filter((agent) => agent.status === 'online').length;
  const linkedPrinters = printers.filter((printer) => printer.osPrinterName).length;
  const emptyCopy = detectedEmptyState({ agentsOnline, agentsTotal: agents.length, linkedPrinters });
  const practice = practiceOnly(printers, isSimulatorPrinterName);

  function toggleInList(key: 'paperSizesLoaded' | 'finishingOptions', value: string) {
    setForm((f) => {
      const list = f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value];
      return { ...f, [key]: list };
    });
  }

  return (
    <div className="page wide shop-page printers-page">
      <ShopNav />
      <ShopTabs />

      <header className="page-heading">
        <div>
          <h1>Printers</h1>
          <p>The printers your counter PC uses. Students can only order what an online printer can print.</p>
        </div>
      </header>

      {added && (
        <div ref={addedRef} tabIndex={-1} className={`notice ${added.kind === 'live' ? 'ok' : 'warn'} printer-added-notice`} role="status">
          <div>
            <strong>{added.title}</strong>
            <p>{added.text}</p>
          </div>
          <div className="row">
            {added.studentUrl && <a className="button-link secondary" href={added.studentUrl} target="_blank" rel="noreferrer">Open student page</a>}
            <Link className="button-link" to={added.to}>{added.action}</Link>
          </div>
        </div>
      )}

      {practice && !added && (
        <div className="notice warn printer-added-notice" role="status">
          <div>
            <strong>Practice mode: only the simulator is added</strong>
            <p>The simulator never prints student orders. Add your real printer to go live.</p>
          </div>
          <Link className="button-link secondary" to="/dashboard/agents">Connect your real printer</Link>
        </div>
      )}

      {(unlinkedDetected.length > 0 || !loaded || linkedPrinters === 0) && (
        <section className="printers-section" aria-labelledby="found-title">
          <h2 id="found-title">Found on your counter PC</h2>
          {!loaded ? (
            <div className="skeleton-card" aria-hidden />
          ) : unlinkedDetected.length === 0 ? (
            <div className="empty-state">
              <strong>{emptyCopy.title}</strong>
              <p>{emptyCopy.body}</p>
              {emptyCopy.connect && <Link className="button-link secondary" to="/dashboard/agents" style={{ marginTop: 16 }}>Set up the counter PC</Link>}
            </div>
          ) : (
            <DetectedPrinters detected={unlinkedDetected} isOwner={isOwner} onAdded={async (name) => { setNotice(''); await Promise.all([refresh(), showWhatChanged(name)]); }} />
          )}
        </section>
      )}

      <section className="printers-section" aria-labelledby="yours-title">
        <h2 id="yours-title">Your printers</h2>
        {notice && <p className="warn-note" role="status">{notice}</p>}
        {loaded && printers.length === 0 ? (
          <p className="dim">No printers yet. Add one your counter PC found above.</p>
        ) : (
          <ul className="printer-list">
            {printers.map((p) => {
              const testVia = testAgents(p.id);
              return (
                <li key={p.id} className={`printer-card status-${p.status}`}>
                  <div className="printer-card-head">
                    <div className="printer-card-name">
                      <strong>{p.label}</strong>
                      <span>
                        {p.paperSizesLoaded.join(', ')} · {p.colorSupport ? 'Colour' : 'Black & white'}
                        {p.finishingOptions.length > 0 ? ` · ${finishingWords(p.finishingOptions)}` : ''}
                        {isSimulatorPrinterName(p.osPrinterName) ? ' · practice only' : ''}
                      </span>
                    </div>
                    <label className="printer-status">
                      <span className="sr-only">Is {p.label} on?</span>
                      <select value={p.status} onChange={(e) => void setStatus(p, e.target.value)} aria-label={`${p.label} status`}>
                        {(['online', 'offline', 'jammed'] as const).map((s) => <option key={s} value={s}>{STATUS_WORDS[s]}</option>)}
                      </select>
                    </label>
                  </div>

                  {!p.osPrinterName && (
                    <div className="printer-unlinked">
                      <span className="badge danger">Not linked</span>
                      {linking === p.id ? (
                        <select aria-label={`Choose the Windows printer for ${p.label}`} autoFocus value="" onChange={(e) => e.target.value && void linkPrinter(p, e.target.value)} onBlur={() => setLinking(null)}>
                          <option value="">Choose a printer the PC found…</option>
                          {unlinkedDetected.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
                        </select>
                      ) : isOwner && unlinkedDetected.length > 0 ? (
                        <button type="button" className="secondary small" onClick={() => setLinking(p.id)}>Link</button>
                      ) : (
                        <span className="dim">Gets no orders until your counter PC finds it.</span>
                      )}
                    </div>
                  )}

                  <div className="printer-actions">
                    {p.osPrinterName && testVia.length === 1 && (
                      <button type="button" className="secondary small" disabled={testing === p.id} onClick={() => void testPrinter(p)}>
                        {testing === p.id ? 'Sending…' : 'Print a test page'}
                      </button>
                    )}
                    {p.osPrinterName && testVia.length > 1 && (
                      <select aria-label={`Computer for the ${p.label} test page`} defaultValue="" disabled={testing === p.id} onChange={(event) => event.target.value && void testPrinter(p, event.target.value)}>
                        <option value="">Print a test page from…</option>
                        {testVia.map((agent) => <option key={agent.id} value={agent.id}>{agent.machineLabel}</option>)}
                      </select>
                    )}
                    {isOwner && <button type="button" className="quiet" onClick={() => beginEdit(p)}>Edit</button>}
                    {isOwner && <button type="button" className="quiet danger-text" onClick={() => void removePrinter(p)}>Remove</button>}
                  </div>
                  {p.lastTestStatus === 'requested' && <p className="printer-note">Test page sent. Waiting for the printer…</p>}
                  {p.lastTestStatus === 'spool_accepted' && <p className="printer-note">Test page sent to the printer. Check the paper.</p>}
                  {p.lastTestStatus === 'failed' && <p className="printer-note bad">Test page failed: {p.lastTestError || 'check the printer and try again'}.</p>}

                  {isOwner && editing === p.id && (
                    <form className="printer-edit" onSubmit={(e) => { e.preventDefault(); void saveEdit(p); }}>
                      <div className="field">
                        <label htmlFor={`printer-label-${p.id}`}>Name</label>
                        <input id={`printer-label-${p.id}`} value={editDraft.label} maxLength={80} onChange={(e) => setEditDraft({ ...editDraft, label: e.target.value })} />
                      </div>
                      <fieldset className="colour-question">
                        <legend>Does it print in colour?</legend>
                        <div className="row">
                          <button type="button" className={`chip ${editDraft.colorSupport ? 'on' : ''}`} aria-pressed={editDraft.colorSupport} onClick={() => setEditDraft({ ...editDraft, colorSupport: true })}>Yes, colour</button>
                          <button type="button" className={`chip ${editDraft.colorSupport ? '' : 'on'}`} aria-pressed={!editDraft.colorSupport} onClick={() => setEditDraft({ ...editDraft, colorSupport: false })}>No, black &amp; white</button>
                        </div>
                      </fieldset>
                      <div className="row">
                        <button type="submit" disabled={!editDraft.label.trim()}>Save</button>
                        <button type="button" className="quiet" onClick={() => setEditing(null)}>Cancel</button>
                      </div>
                    </form>
                  )}

                  {isOwner && p.osPrinterName && (
                    <details className="disclosure printer-advanced" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && editingMedia !== p.id) beginMediaEdit(p); }}>
                      <summary>Advanced: paper size and tray names</summary>
                      <p className="dim">Only change these if the printer picks the wrong paper. They must match the names in the Windows printer driver. Linked to {p.osPrinterName}, about {p.avgPagesPerMinute} pages a minute.</p>
                      {editingMedia === p.id && (
                        <form onSubmit={(e) => { e.preventDefault(); void saveMedia(p); }}>
                          <div className="stack">
                            {p.paperSizesLoaded.map((paper) => (
                              <div className="form-row align-end" key={paper}>
                                <div className="field" style={{ minWidth: 90 }}><span className="field-label">PrintQs paper</span><strong>{paper}</strong></div>
                                <div className="field grow">
                                  <label htmlFor={`paper-size-${p.id}-${paper}`}>Paper size in Windows</label>
                                  <input id={`paper-size-${p.id}-${paper}`} value={mediaDraft[paper]?.paperSize ?? paper} onChange={(e) => updateMedia(paper, { paperSize: e.target.value })} placeholder="A4" />
                                </div>
                                <div className="field grow">
                                  <label htmlFor={`paper-bin-${p.id}-${paper}`}>Tray <span className="optional-label">optional</span></label>
                                  <input id={`paper-bin-${p.id}-${paper}`} value={mediaDraft[paper]?.bin ?? ''} onChange={(e) => updateMedia(paper, { bin: e.target.value || null })} placeholder="Tray 2" />
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="row" style={{ marginTop: 12 }}>
                            <button type="submit" disabled={Object.values(mediaDraft).some((media) => !media.paperSize.trim())}>Save paper settings</button>
                            <button type="button" className="quiet" onClick={() => setEditingMedia(null)}>Cancel</button>
                          </div>
                        </form>
                      )}
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {shop && isOwner && (
        <section className="printers-section" aria-labelledby="choice-title">
          <h2 id="choice-title">Choosing a printer at the counter</h2>
          <div className="setting-row">
            <div>
              <strong>Pick the best printer automatically</strong>
              <p className="dim">Recommended. Each order goes to the fastest online printer that can print it. Turn off to choose by hand every time.</p>
            </div>
            <button type="button" role="switch" aria-checked={shop.autoAssignEnabled} className={`toggle-button ${shop.autoAssignEnabled ? 'on' : ''}`} onClick={() => void toggleAutoAssign()}>
              <span aria-hidden /> {shop.autoAssignEnabled ? 'On' : 'Off'}
            </button>
          </div>
        </section>
      )}

      {isOwner && (
        <details className="disclosure printers-manual">
          <summary>Add a printer by hand</summary>
          <p className="dim">Only for a printer your counter PC has not found yet. It gets no orders until you link it.</p>
          <form className="printer-form stack" onSubmit={(e) => { e.preventDefault(); void addPrinter(); }}>
            <div className="field">
              <label htmlFor="plabel">Name</label>
              <input id="plabel" type="text" placeholder="Printer near the entrance" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
            <div>
              <span className="field-label">It can print</span>
              <div className="row">
                {['A4', 'A3'].map((size) => (
                  <button type="button" key={size} className={`chip ${form.paperSizesLoaded.includes(size) ? 'on' : ''}`} aria-pressed={form.paperSizesLoaded.includes(size)} onClick={() => toggleInList('paperSizesLoaded', size)}>{size}</button>
                ))}
                <button type="button" className={`chip ${form.colorSupport ? 'on' : ''}`} aria-pressed={form.colorSupport} onClick={() => setForm({ ...form, colorSupport: !form.colorSupport })}>Colour</button>
                {['stapling', 'spiral_binding'].map((f) => (
                  <button type="button" key={f} className={`chip ${form.finishingOptions.includes(f) ? 'on' : ''}`} aria-pressed={form.finishingOptions.includes(f)} onClick={() => toggleInList('finishingOptions', f)}>{f.replace('_', ' ')}</button>
                ))}
              </div>
            </div>
            <div className="field" style={{ maxWidth: 200 }}>
              <label htmlFor="ppm">Pages per minute</label>
              <input id="ppm" type="number" min={1} max={200} value={form.avgPagesPerMinute} onChange={(e) => setForm({ ...form, avgPagesPerMinute: Number(e.target.value) || 15 })} />
            </div>
            <div><button type="submit" disabled={!form.label || form.paperSizesLoaded.length === 0}>Add printer</button></div>
          </form>
        </details>
      )}

      {error && <div className="error-box" role="alert">{error}</div>}
    </div>
  );
}
