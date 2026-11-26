import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, api, getToken, rupees } from '../../api.js';
import { createLatestRequest, isAbortError } from '../../lib/latestRequest.js';
import { loadRemembered, saveRemembered, startingSpecs } from '../../lib/printSettings.js';
import { addFiles, clearDraft, docMatches, getDraft, openDoc, readyParts, retryJoin, setExcluded, useOrderDraft, type Draft } from '../../lib/orderDraft.js';
import { MAX_ORDER_FILES } from '../../lib/fileChoice.js';
import { compileRange, partSelectedCount, rangeProblem, totalPages, type Excluded } from '../../lib/pageSelection.js';
import { buildParts, seedPerFile, settingsFor, settingsSummary, sheetsFor, type FileSettings, type PerFile } from '../../lib/fileSettings.js';
import { studentLoginPath } from '../../lib/studentReturn.js';
import { enablePush, pushPermission } from '../../push.js';
import Topbar from '../../components/Topbar.js';
import OrderFiles, { useFileDrop } from '../../components/OrderFiles.js';
import type { PendingFile } from '../../components/PageBoard.js';

interface Paper {
  id: string;
  label: string;
  colorAvailable: boolean;
}
interface Binding {
  id: string;
  label: string;
}
interface ShopOptions {
  papers: Paper[];
  bindings: Binding[];
  duplexEnabled: boolean;
  /** every online PC of the shop can print files with their own settings */
  perFileSettings?: boolean;
}
interface Specs {
  copies: number;
  paperSize: string;
  color: boolean;
  duplex: boolean;
  binding: string | null;
  pageRange: string | null;
  parts?: { pages: string; copies: number; color: boolean; duplex: boolean }[];
}
interface Quote {
  pagesPerCopy: number;
  totalPaise: number;
}

// pdf.js is ~400 KB: load it only when this screen is opened.
const PageBoard = lazy(() => import('../../components/PageBoard.js'));

/** Why colour can't be chosen, or null when it can. */
export function inkUnavailableNote(papers: Paper[], paperId: string): string | null {
  const paper = papers.find((p) => p.id === paperId);
  if (paper?.colorAvailable) return null;
  if (!papers.some((p) => p.colorAvailable)) return 'This shop prints black & white only right now.';
  return `Colour isn’t available on ${paper?.label ?? 'this paper'} here. Choose another paper size for colour.`;
}

/**
 * What still stands between the student and "Place order", or null. `wait`
 * reasons resolve by themselves (uploads, preparing); `fix` reasons need the
 * student (a broken file, no pages chosen).
 */
export function orderBlocker(draft: Draft | null, rangeIssue: string | null): { kind: 'wait' | 'fix'; text: string } | null {
  const items = draft?.items ?? [];
  if (items.length === 0) return { kind: 'fix', text: 'Add a file to continue.' };
  const count = (status: string) => items.filter((it) => it.status === status).length;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  if (count('uploading')) return { kind: 'wait', text: `Uploading ${files(count('uploading'))}…` };
  if (count('preparing')) return { kind: 'wait', text: `Preparing ${files(count('preparing'))}…` };
  const failed = count('failed');
  if (failed) return { kind: 'fix', text: failed === 1 ? 'One file could not be added. Remove it to continue.' : `${failed} files could not be added. Remove them to continue.` };
  if (draft?.doc?.status === 'failed') return { kind: 'fix', text: draft.doc.error ?? 'Could not put your files together.' };
  if (!docMatches(draft)) return { kind: 'wait', text: 'Putting your files together…' };
  if (rangeIssue) return { kind: 'fix', text: rangeIssue };
  return null;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A row of one-tap choices (radio semantics). */
function Choice<T extends string>({ label, value, options, onChange, describedBy, id, groupLabel, className }: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  describedBy?: string;
  /** unique id base when the same label repeats (one control per file) */
  id?: string;
  /** a fuller name for screen readers, e.g. "Ink for notes.pdf" */
  groupLabel?: string;
  className?: string;
}) {
  const labelId = `${id ?? `choice-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}-label`;
  return (
    <div className={`choice${className ? ` ${className}` : ''}`}>
      <span className="field-label" id={labelId}>{label}</span>
      <div
        className="seg"
        role="radiogroup"
        {...(groupLabel ? { 'aria-label': groupLabel } : { 'aria-labelledby': labelId })}
        aria-describedby={describedBy}
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            className={value === o.value ? 'on' : undefined}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const NO_EXCLUSIONS: Excluded = {};

export default function NewJob() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const docParam = params.get('doc');
  const navigate = useNavigate();
  const draft = useOrderDraft(slug);
  const signedIn = Boolean(getToken('student'));

  const [opts, setOpts] = useState<ShopOptions | null>(null);
  const [shopName, setShopName] = useState('');
  const [specs, setSpecs] = useState<Specs | null>(null);
  const [planTime, setPlanTime] = useState(false);
  const [slot, setSlot] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote; unsupported?: { code: string; message: string }[] } | null>(null);
  const [quoteErrorKey, setQuoteErrorKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  // different copies / ink / sides per file (only when the shop's PC app can print them)
  const [perFileMode, setPerFileMode] = useState(false);
  const [perFile, setPerFile] = useState<PerFile>({});

  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');

  // a file dropped anywhere on the page joins the order
  const drop = useFileDrop(Boolean(draft) && (draft?.items.length ?? 0) < MAX_ORDER_FILES, (files) => addFiles(slug, files));

  const latestQuote = useRef(createLatestRequest());
  const submitting = useRef(false);
  const idemKey = useRef(crypto.randomUUID());

  // Signed out: sign in and come back here. No files and no link: start at the shop page.
  useEffect(() => {
    if (!signedIn) navigate(studentLoginPath(`/s/${slug}/order${docParam ? `?doc=${encodeURIComponent(docParam)}` : ''}`), { replace: true });
    else if (!docParam && !getDraft(slug)) navigate(`/s/${slug}`, { replace: true });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A link (or a refresh) names the joined document: rebuild the order from it.
  useEffect(() => {
    if (signedIn && docParam) void openDoc(slug, docParam);
  }, [slug, docParam, signedIn]);

  // Keep the address pointing at the current joined document, so a refresh brings it back.
  useEffect(() => {
    if (!draft || draft.loading) return;
    if (docMatches(draft) && draft.doc.fileId !== docParam) setParams({ doc: draft.doc.fileId }, { replace: true });
    else if (draft.items.length === 0 && docParam && !draft.loadError) setParams({}, { replace: true });
  }, [draft, docParam, setParams]);

  // the shop's options; settings start from last time at this shop
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    api<{ shop: { name: string; options: ShopOptions } }>(`/api/public/shops/${slug}`)
      .then((res) => {
        if (cancelled) return;
        setOpts(res.shop.options);
        setShopName(res.shop.name);
        setSpecs((prev) => prev ?? startingSpecs(res.shop.options.papers, res.shop.options.duplexEnabled, loadRemembered(slug)));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, [slug]);

  const parts = useMemo(() => readyParts(draft), [draft]);
  const excluded = draft?.excluded ?? NO_EXCLUSIONS;
  const docFileId = docMatches(draft) ? draft.doc.fileId : null;
  const range = useMemo(() => compileRange(parts, excluded), [parts, excluded]);
  const rangeIssue = rangeProblem(range);
  const blocker = orderBlocker(draft, rangeIssue);
  const blockerText = blocker?.text ?? null;
  const perFileOffered = parts.length > 1 && Boolean(opts?.perFileSettings);
  const perFileOn = perFileMode && perFileOffered;
  const defaults: FileSettings | null = useMemo(
    () => (specs ? { copies: specs.copies, color: specs.color, duplex: specs.duplex } : null),
    [specs],
  );
  const orderSpecs = useMemo((): Specs | null => {
    if (!specs || !defaults) return null;
    if (!perFileOn) return { ...specs, pageRange: range };
    return { ...specs, pageRange: range, parts: buildParts(parts, excluded, perFile, defaults) };
  }, [specs, defaults, range, perFileOn, parts, excluded, perFile]);

  const quoteKey = docFileId && orderSpecs ? JSON.stringify([docFileId, orderSpecs, appliedCoupon]) : '';
  // The quote is only trusted while it answers EXACTLY the order on screen.
  const quoteCurrent = quoted !== null && quoted.key === quoteKey;
  const quoteFailed = quoteErrorKey !== null && quoteErrorKey === quoteKey;
  const quote = quoteCurrent ? quoted.quote : null;
  // The shop cannot produce these options (e.g. colour on a B/W-only shop): say so now, not at the counter.
  const unsupported = quoteCurrent ? (quoted.unsupported ?? []) : [];

  // Debounced (250 ms) quote refresh with abort + sequencing: the total shown
  // always belongs to the order on screen, never to an older request.
  useEffect(() => {
    if (!docFileId || !orderSpecs || blockerText) return;
    const key = JSON.stringify([docFileId, orderSpecs, appliedCoupon]);
    const guard = latestQuote.current;
    const t = setTimeout(() => {
      const ticket = guard.begin();
      api<{ quote: Quote; pages: number; unsupported?: { code: string; message: string }[] }>('/api/jobs/quote', {
        method: 'POST',
        role: 'student',
        signal: ticket.signal,
        body: appliedCoupon ? { fileId: docFileId, specs: orderSpecs, couponCode: appliedCoupon } : { fileId: docFileId, specs: orderSpecs },
      })
        .then((res) => {
          if (!ticket.isCurrent()) return;
          setQuoted({ key, quote: res.quote, unsupported: res.unsupported });
          setQuoteErrorKey(null);
          setError('');
        })
        .catch((err) => {
          if (isAbortError(err) || !ticket.isCurrent()) return;
          setQuoted(null);
          setQuoteErrorKey(key);
          setError(err instanceof Error ? err.message : 'Could not price this order.');
        });
    }, 250);
    return () => {
      clearTimeout(t);
      guard.cancel();
    };
  }, [docFileId, orderSpecs, appliedCoupon, blockerText]);

  async function applyCoupon() {
    if (!orderSpecs || !docFileId || !couponInput.trim()) return;
    setCouponError('');
    try {
      const code = couponInput.trim();
      const res = await api<{ quote: Quote; pages: number; unsupported?: { code: string; message: string }[] }>('/api/jobs/quote', {
        method: 'POST',
        role: 'student',
        body: { fileId: docFileId, specs: orderSpecs, couponCode: code },
      });
      setQuoted({ key: JSON.stringify([docFileId, orderSpecs, code]), quote: res.quote, unsupported: res.unsupported });
      setAppliedCoupon(code);
    } catch (err) {
      setCouponError(err instanceof Error ? err.message : 'This coupon does not work.');
    }
  }

  function set<K extends keyof Specs>(key: K, value: Specs[K]) {
    setSpecs((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const paper = opts?.papers.find((p) => p.id === specs?.paperSize);
  const colorAvailable = Boolean(paper?.colorAvailable);
  const inkNote = opts && specs ? inkUnavailableNote(opts.papers, specs.paperSize) : null;

  // if the chosen paper can't do colour, force B/W (for every file too)
  useEffect(() => {
    if (colorAvailable) return;
    if (specs?.color) set('color', false);
    setPerFile((prev) => (Object.values(prev).some((f) => f.color)
      ? Object.fromEntries(Object.entries(prev).map(([id, f]) => [id, { ...f, color: false }]))
      : prev));
  }, [specs?.paperSize]); // eslint-disable-line react-hooks/exhaustive-deps

  function choosePerFile(on: boolean) {
    if (on && defaults) setPerFile((prev) => seedPerFile(parts, prev, defaults));
    setPerFileMode(on);
  }

  function setFile(fileId: string, change: Partial<FileSettings>) {
    if (!defaults) return;
    setPerFile((prev) => ({ ...prev, [fileId]: { ...settingsFor(fileId, prev, defaults), ...change } }));
  }

  async function placeOrder() {
    if (!orderSpecs || !docFileId || blocker || busy || submitting.current) return; // double-tap guard (state is async)
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { fileId: docFileId, specs: orderSpecs, mode: planTime ? 'scheduled' : 'instant' };
      if (planTime) body.scheduledTime = new Date(slot).toISOString();
      if (appliedCoupon) body.couponCode = appliedCoupon;
      const res = await api<{
        job: { id: string };
        checkout: { mode: 'pay_at_shop'; amountPaise: number };
      }>('/api/jobs', { method: 'POST', role: 'student', body, idempotencyKey: idemKey.current });
      saveRemembered(slug, { paperSize: orderSpecs.paperSize, duplex: orderSpecs.duplex });
      if (pushPermission() === 'default') void enablePush();
      clearDraft(slug);
      navigate(`/jobs/${res.job.id}`);
    } catch (err) {
      // A real answer ends this attempt; a network failure keeps the key so a
      // retry cannot create a second order if the first one actually landed.
      if (err instanceof ApiError) idemKey.current = crypto.randomUUID();
      setError(err instanceof Error ? err.message : 'Could not place the order. Try again.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const back = <Link to={`/s/${slug}`}>Shop page</Link>;

  if (draft?.loadError && draft.items.length === 0) {
    return (
      <div className="page wide checkout-page">
        <Topbar right={back} />
        <div className="empty-state" role="alert">
          <strong>This order can’t be opened</strong>
          <p>{draft.loadError}</p>
          <Link to={`/s/${slug}`} className="button-link" style={{ marginTop: 14 }} onClick={() => clearDraft(slug)}>Add your files again</Link>
        </div>
      </div>
    );
  }

  if (!opts || !specs || !draft || draft.loading) {
    return (
      <div className="page wide checkout-page">
        <Topbar right={back} />
        {loadFailed ? (
          <div className="empty-state" role="alert">
            <strong>Could not open this order</strong>
            <p>Check your connection and try again.</p>
            <button type="button" style={{ marginTop: 14 }} onClick={() => window.location.reload()}>Try again</button>
          </div>
        ) : (
          <div className="skeleton-list" role="status" aria-label="Loading your print settings">
            <div className="skeleton-card" style={{ height: 70 }} />
            <div className="skeleton-card" style={{ height: 320 }} />
          </div>
        )}
      </div>
    );
  }

  const minSlot = toLocalInput(new Date(Date.now() + 20 * 60_000));
  const maxSlot = toLocalInput(new Date(Date.now() + 72 * 3_600_000));
  const blocked = Boolean(blocker) || !quote || busy || unsupported.length > 0;
  const bindingOptions = [{ value: 'none', label: 'None' }, ...opts.bindings.map((b) => ({ value: b.id, label: b.label }))];
  // a per-file quote already counts every printed page (pages x copies of each file)
  const printedPages = quote ? quote.pagesPerCopy * (orderSpecs?.parts ? 1 : specs.copies) : null;
  const runs = orderSpecs?.parts ?? [{ pages: orderSpecs?.pageRange ?? null, copies: specs.copies, duplex: specs.duplex }];
  const sheets = quote && runs.some((run) => run.duplex) ? sheetsFor(runs, totalPages(parts)) : null;
  const grayFiles = new Set(parts.filter((part) => !(perFileOn && defaults ? settingsFor(part.fileId, perFile, defaults).color : specs.color)).map((part) => part.fileId));
  const fileNotes = perFileOn && defaults
    ? Object.fromEntries(parts.map((part) => [part.fileId, settingsSummary(settingsFor(part.fileId, perFile, defaults), opts.duplexEnabled)]))
    : undefined;
  const pending: PendingFile[] = draft.items
    .filter((it) => it.status !== 'ready')
    .map((it) => ({ key: it.key, name: it.name, status: it.status as PendingFile['status'] }));
  const fileCount = draft.items.length;
  const allPages = totalPages(parts);
  const title = fileCount === 1 ? draft.items[0]!.name : 'Your print order';

  return (
    <div className="page wide checkout-page" {...drop.handlers}>
      <Topbar right={back} />
      <div className="checkout-grid">
        <div className="checkout-main">
          <header className="checkout-head">
            <p className="checkout-shop">{shopName}</p>
            <h1>{title}</h1>
            <p className="dim">
              {fileCount > 1 ? `${fileCount} files · ` : ''}
              {allPages ? `${allPages} page${allPages === 1 ? '' : 's'}` : 'Getting your pages ready…'} · nothing to pay now
            </p>
          </header>

          <OrderFiles slug={slug} draft={draft} dragging={drop.dragging} notes={fileNotes} />

          <section className="checkout-card settings-card" aria-labelledby="settings-title">
            <h2 id="settings-title" className="card-title">Print settings</h2>

            {perFileOffered && (
              <Choice
                label="Settings for"
                value={perFileOn ? 'each' : 'all'}
                options={[{ value: 'all', label: 'All files' }, { value: 'each', label: 'Each file' }]}
                onChange={(v) => choosePerFile(v === 'each')}
                describedBy="per-file-help"
              />
            )}
            {perFileOffered && (
              <p id="per-file-help" className="field-help choice-help">
                {perFileOn ? 'Choose copies, ink and sides for every file. Paper and binding are for the whole order.' : 'Want a colour cover or extra copies of one file? Choose “Each file”.'}
              </p>
            )}
            {parts.length > 1 && !opts.perFileSettings && (
              <p className="field-help">This shop prints every file with the same settings.</p>
            )}

            {!perFileOn && (
              <div className="field copies-field">
                <label htmlFor="copies">Copies</label>
                <div className="stepper">
                  <button type="button" className="secondary" aria-label="One copy less" disabled={specs.copies <= 1} onClick={() => set('copies', Math.max(1, specs.copies - 1))}>−</button>
                  <input id="copies" type="number" inputMode="numeric" min={1} max={100} value={specs.copies} onChange={(e) => set('copies', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
                  <button type="button" className="secondary" aria-label="One copy more" disabled={specs.copies >= 100} onClick={() => set('copies', Math.min(100, specs.copies + 1))}>+</button>
                </div>
              </div>
            )}

            {opts.papers.length <= 3 ? (
              <Choice label="Paper" value={specs.paperSize} options={opts.papers.map((p) => ({ value: p.id, label: p.label }))} onChange={(v) => set('paperSize', v)} />
            ) : (
              <div className="field">
                <label htmlFor="paper">Paper</label>
                <select id="paper" value={specs.paperSize} onChange={(e) => set('paperSize', e.target.value)}>
                  {opts.papers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            )}

            {perFileOn && defaults ? (
              <ol className="file-settings" aria-label="Settings for each file">
                {parts.map((part, index) => {
                  const own = settingsFor(part.fileId, perFile, defaults);
                  const chosen = partSelectedCount(part, excluded);
                  return (
                    <li key={part.fileId} className={`file-setting${chosen === 0 ? ' unused' : ''}`}>
                      <div className="file-setting-head">
                        <span className="file-order" aria-hidden>{index + 1}</span>
                        <strong title={part.name}>{part.name}</strong>
                        <span className="dim">{chosen === 0 ? 'no pages chosen' : `${chosen} page${chosen === 1 ? '' : 's'}`}</span>
                      </div>
                      <div className="file-setting-controls">
                        <div className="mini-field">
                          <span className="field-label" aria-hidden>Copies</span>
                          <div className="stepper small">
                            <button type="button" className="secondary" aria-label={`One copy less of ${part.name}`} disabled={own.copies <= 1} onClick={() => setFile(part.fileId, { copies: Math.max(1, own.copies - 1) })}>−</button>
                            <input type="number" inputMode="numeric" min={1} max={100} aria-label={`Copies of ${part.name}`} value={own.copies} onChange={(e) => setFile(part.fileId, { copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
                            <button type="button" className="secondary" aria-label={`One copy more of ${part.name}`} disabled={own.copies >= 100} onClick={() => setFile(part.fileId, { copies: Math.min(100, own.copies + 1) })}>+</button>
                          </div>
                        </div>
                        <Choice
                          id={`ink-${index}`}
                          className="mini"
                          label="Ink"
                          groupLabel={`Ink for ${part.name}`}
                          value={own.color ? 'color' : 'bw'}
                          options={[{ value: 'bw', label: 'B/W' }, { value: 'color', label: 'Colour', disabled: !colorAvailable }]}
                          onChange={(v) => setFile(part.fileId, { color: v === 'color' })}
                        />
                        {opts.duplexEnabled && (
                          <Choice
                            id={`sides-${index}`}
                            className="mini"
                            label="Sides"
                            groupLabel={`Sides for ${part.name}`}
                            value={own.duplex ? 'duplex' : 'single'}
                            options={[{ value: 'single', label: 'One' }, { value: 'duplex', label: 'Both' }]}
                            onChange={(v) => setFile(part.fileId, { duplex: v === 'duplex' })}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <>
                <Choice
                  label="Ink"
                  value={specs.color ? 'color' : 'bw'}
                  options={[{ value: 'bw', label: 'Black & white' }, { value: 'color', label: 'Colour', disabled: !colorAvailable }]}
                  onChange={(v) => set('color', v === 'color')}
                  describedBy={inkNote ? 'color-hint' : undefined}
                />
                {inkNote && <p id="color-hint" className="field-help choice-help">{inkNote}</p>}
                {opts.duplexEnabled && (
                  <Choice
                    label="Sides"
                    value={specs.duplex ? 'duplex' : 'single'}
                    options={[{ value: 'single', label: 'One side' }, { value: 'duplex', label: 'Both sides' }]}
                    onChange={(v) => set('duplex', v === 'duplex')}
                  />
                )}
              </>
            )}
            {perFileOn && inkNote && <p className="field-help">{inkNote}</p>}

            {opts.bindings.length > 0 && (bindingOptions.length <= 3 ? (
              <Choice label="Binding" value={specs.binding ?? 'none'} options={bindingOptions} onChange={(v) => set('binding', v === 'none' ? null : v)} />
            ) : (
              <div className="field">
                <label htmlFor="binding">Binding</label>
                <select id="binding" value={specs.binding ?? 'none'} onChange={(e) => set('binding', e.target.value === 'none' ? null : e.target.value)}>
                  {bindingOptions.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                </select>
              </div>
            ))}
          </section>

          <section className="checkout-extras" aria-label="Optional">
            <label className="check-row">
              <input type="checkbox" checked={planTime} onChange={(e) => setPlanTime(e.target.checked)} />
              <span>Plan a visit time <span className="optional-label">optional</span></span>
            </label>
            {planTime && (
              <div className="field plan-time">
                <label htmlFor="slot">When will you come?</label>
                <input id="slot" type="datetime-local" value={slot} min={minSlot} max={maxSlot} onChange={(e) => setSlot(e.target.value)} />
                <p className="field-help">We remind you near this time. You still join the line only when you are at the shop.</p>
              </div>
            )}
            {appliedCoupon ? (
              <p className="coupon-applied">Coupon <strong className="mono">{appliedCoupon}</strong> applied. <button type="button" className="quiet" onClick={() => { setAppliedCoupon(null); setCouponInput(''); }}>Remove</button></p>
            ) : (
              <details className="coupon">
                <summary>Have a coupon?</summary>
                <form className="row nowrap coupon-form" onSubmit={(e) => { e.preventDefault(); void applyCoupon(); }}>
                  <input type="text" aria-label="Coupon code" placeholder="Coupon code" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} aria-invalid={couponError ? true : undefined} />
                  <button type="submit" className="secondary" disabled={!couponInput.trim() || !docFileId}>Apply</button>
                </form>
                {couponError && <p className="field-error" role="alert">{couponError}</p>}
              </details>
            )}
          </section>
        </div>

        <aside className="checkout-side">
          <Suspense fallback={<section className="pages-card"><div className="pdf-status" role="status">Loading pages…</div></section>}>
            <PageBoard
              parts={parts}
              pending={pending}
              excluded={excluded}
              onChange={(next) => setExcluded(slug, next)}
              grayFiles={grayFiles}
              docFileId={docFileId}
            />
          </Suspense>

          <div className="checkout-bar">
            {blocker?.kind === 'wait' && (
              <div className="bar-wait" role="status"><span className="spinner" aria-hidden /> {blocker.text}</div>
            )}
            {(blocker?.kind === 'fix' || unsupported.length > 0 || error) && (
              <div className="bar-alert" role="alert">
                {blocker?.kind === 'fix' && <p>{blocker.text}</p>}
                {blocker?.kind === 'fix' && draft.doc?.status === 'failed' && (
                  <button type="button" className="quiet" onClick={() => retryJoin(slug)}>Try again</button>
                )}
                {!blocker && unsupported.map((u) => <p key={u.code}>{u.message}</p>)}
                {!blocker && error && <p>{error}</p>}
              </div>
            )}
            <div className="bar-total" aria-live="polite">
              <span className="bar-label">
                Total{printedPages ? ` · ${printedPages} page${printedPages === 1 ? '' : 's'}` : ''}{sheets ? ` on ${sheets} sheet${sheets === 1 ? '' : 's'}` : ''}
              </span>
              <strong className="num" aria-busy={!quote && !quoteFailed && !blocker}>
                {quote && !blocker ? rupees(quote.totalPaise) : quoteFailed && !blocker ? 'Unavailable' : blocker ? '—' : <span className="total-loading">Updating…</span>}
              </strong>
              <span className="bar-sub">Pay at the shop · cash or UPI</span>
            </div>
            <button type="button" className="large place-order" disabled={blocked} onClick={() => void placeOrder()}>
              {busy ? 'Placing order…' : 'Place order'}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
