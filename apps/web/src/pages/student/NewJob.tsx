import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { parsePageRange } from '@printq/shared';
import { ApiError, api, rupees } from '../../api.js';
import { createLatestRequest, isAbortError } from '../../lib/latestRequest.js';
import { loadRemembered, saveRemembered, startingSpecs } from '../../lib/printSettings.js';
import { enablePush, pushPermission } from '../../push.js';
import Topbar from '../../components/Topbar.js';

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
}
interface Specs {
  copies: number;
  paperSize: string;
  color: boolean;
  duplex: boolean;
  binding: string | null;
  pageRange: string | null;
}
interface Quote {
  pagesPerCopy: number;
  totalPaise: number;
}

// pdf.js is ~400 KB: load it only when this screen is opened.
const PdfPreview = lazy(() => import('../../components/PdfPreview.js'));

/** Why colour can't be chosen, or null when it can. */
export function inkUnavailableNote(papers: Paper[], paperId: string): string | null {
  const paper = papers.find((p) => p.id === paperId);
  if (paper?.colorAvailable) return null;
  if (!papers.some((p) => p.colorAvailable)) return 'This shop prints black & white only right now.';
  return `Colour isn’t available on ${paper?.label ?? 'this paper'} here. Choose another paper size for colour.`;
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A row of one-tap choices (radio semantics). */
function Choice<T extends string>({ label, value, options, onChange, describedBy }: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  describedBy?: string;
}) {
  return (
    <div className="choice">
      <span className="field-label" id={`${label}-label`}>{label}</span>
      <div className="seg" role="radiogroup" aria-labelledby={`${label}-label`} aria-describedby={describedBy}>
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

export default function NewJob() {
  const { slug = '', fileId = '' } = useParams();
  const navigate = useNavigate();
  const [opts, setOpts] = useState<ShopOptions | null>(null);
  const [shopName, setShopName] = useState('');
  const [fileName, setFileName] = useState('');
  const [specs, setSpecs] = useState<Specs | null>(null);
  const [planTime, setPlanTime] = useState(false);
  const [slot, setSlot] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [pages, setPages] = useState<number | null>(null);
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote; unsupported?: { code: string; message: string }[] } | null>(null);
  const [quoteErrorKey, setQuoteErrorKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const [pageMode, setPageMode] = useState<'all' | 'custom'>('all');
  const [rangeAdvanced, setRangeAdvanced] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(1);
  const [rawRange, setRawRange] = useState('');
  const [rangeError, setRangeError] = useState('');

  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<string | null>(null);
  const [couponError, setCouponError] = useState('');

  const mode: 'instant' | 'scheduled' = planTime ? 'scheduled' : 'instant';
  const quoteKey = specs ? JSON.stringify([specs, appliedCoupon]) : '';
  // The quote is only trusted while it answers EXACTLY the options on screen.
  const quoteCurrent = quoted !== null && quoted.key === quoteKey;
  const quoteFailed = quoteErrorKey !== null && quoteErrorKey === quoteKey;
  const quote = quoteCurrent ? quoted.quote : null;
  // The shop cannot produce these options (e.g. colour on a B/W-only shop): say so now, not at the counter.
  const unsupported = quoteCurrent ? (quoted.unsupported ?? []) : [];
  const latestQuote = useRef(createLatestRequest());
  const submitting = useRef(false);
  const idemKey = useRef(crypto.randomUUID());

  // the shop's options and this file, in parallel; settings start from last time at this shop
  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    Promise.all([
      api<{ shop: { name: string; options: ShopOptions } }>(`/api/public/shops/${slug}`),
      api<{ file: { originalName: string; pages: number | null } }>(`/api/files/${fileId}`, { role: 'student' }).catch(() => null),
    ])
      .then(([shopRes, fileRes]) => {
        if (cancelled) return;
        setOpts(shopRes.shop.options);
        setShopName(shopRes.shop.name);
        if (fileRes) {
          setFileName(fileRes.file.originalName);
          if (fileRes.file.pages) setPages(fileRes.file.pages);
        }
        setSpecs(startingSpecs(shopRes.shop.options.papers, shopRes.shop.options.duplexEnabled, loadRemembered(slug)));
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => { cancelled = true; };
  }, [slug, fileId]);

  // Debounced (250 ms) quote refresh with abort + sequencing: the total shown
  // always belongs to the options on screen, never to an older request.
  useEffect(() => {
    if (!specs) return;
    const key = JSON.stringify([specs, appliedCoupon]);
    const guard = latestQuote.current;
    const t = setTimeout(() => {
      const ticket = guard.begin();
      api<{ quote: Quote; pages: number; unsupported?: { code: string; message: string }[] }>('/api/jobs/quote', {
        method: 'POST',
        role: 'student',
        signal: ticket.signal,
        body: appliedCoupon ? { fileId, specs, couponCode: appliedCoupon } : { fileId, specs },
      })
        .then((res) => {
          if (!ticket.isCurrent()) return;
          setQuoted({ key, quote: res.quote, unsupported: res.unsupported });
          setQuoteErrorKey(null);
          setPages(res.pages);
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
  }, [specs, appliedCoupon, fileId]);

  async function applyCoupon() {
    if (!specs || !couponInput.trim()) return;
    setCouponError('');
    try {
      const res = await api<{ quote: Quote; pages: number; unsupported?: { code: string; message: string }[] }>('/api/jobs/quote', {
        method: 'POST',
        role: 'student',
        body: { fileId, specs, couponCode: couponInput.trim() },
      });
      const code = couponInput.trim();
      setQuoted({ key: JSON.stringify([specs, code]), quote: res.quote, unsupported: res.unsupported });
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

  // if the chosen paper can't do colour, force B/W
  useEffect(() => {
    if (specs?.color && !colorAvailable) set('color', false);
  }, [specs?.paperSize]); // eslint-disable-line react-hooks/exhaustive-deps

  // once the page count is known, default the custom-range "to" field to the last page
  useEffect(() => {
    if (pages && rangeFrom === 1 && rangeTo === 1) setRangeTo(pages);
  }, [pages]); // eslint-disable-line react-hooks/exhaustive-deps

  // compose + validate the page range client-side before it ever reaches pricing/checkout
  useEffect(() => {
    if (pageMode === 'all') {
      setRangeError('');
      set('pageRange', null);
      return;
    }
    const candidate = rangeAdvanced ? rawRange.trim() : rangeFrom === rangeTo ? `${rangeFrom}` : `${rangeFrom}-${rangeTo}`;
    if (!candidate) {
      setRangeError('Enter the pages you want, for example 1-5');
      return;
    }
    if (!pages) return;
    try {
      parsePageRange(candidate, pages);
      setRangeError('');
      set('pageRange', candidate === `1-${pages}` ? null : candidate);
    } catch (err) {
      setRangeError(err instanceof Error ? err.message : 'Those pages are not in this file.');
    }
  }, [pageMode, rangeAdvanced, rangeFrom, rangeTo, rawRange, pages]); // eslint-disable-line react-hooks/exhaustive-deps

  async function placeOrder() {
    if (!specs || busy || submitting.current) return; // double-tap guard (state is async)
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { fileId, specs, mode };
      if (mode === 'scheduled') body.scheduledTime = new Date(slot).toISOString();
      if (appliedCoupon) body.couponCode = appliedCoupon;
      const res = await api<{
        job: { id: string };
        checkout: { mode: 'pay_at_shop'; amountPaise: number };
      }>('/api/jobs', { method: 'POST', role: 'student', body, idempotencyKey: idemKey.current });
      saveRemembered(slug, { paperSize: specs.paperSize, duplex: specs.duplex });
      if (pushPermission() === 'default') void enablePush();
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

  if (!opts || !specs) {
    return (
      <div className="page wide checkout-page">
        <Topbar right={<Link to={`/s/${slug}`}>Change file</Link>} />
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
  const blocked = !quote || busy || !!rangeError || unsupported.length > 0;
  const bindingOptions = [{ value: 'none', label: 'None' }, ...opts.bindings.map((b) => ({ value: b.id, label: b.label }))];
  const totalPages = quote ? quote.pagesPerCopy * specs.copies : null;

  return (
    <div className="page wide checkout-page">
      <Topbar right={<Link to={`/s/${slug}`}>Change file</Link>} />
      <div className="checkout-grid">
        <div className="checkout-main">
          <header className="checkout-head">
            <p className="checkout-shop">{shopName}</p>
            <h1>{fileName || 'Your print'}</h1>
            <p className="dim">{pages ? `${pages} page${pages === 1 ? '' : 's'}` : 'Counting pages…'} · nothing to pay now</p>
          </header>

          <section className="checkout-card" aria-labelledby="settings-title">
            <h2 id="settings-title" className="sr-only">Print settings</h2>
            <div className="field copies-field">
              <label htmlFor="copies">Copies</label>
              <div className="stepper">
                <button type="button" className="secondary" aria-label="One copy less" disabled={specs.copies <= 1} onClick={() => set('copies', Math.max(1, specs.copies - 1))}>−</button>
                <input id="copies" type="number" inputMode="numeric" min={1} max={100} value={specs.copies} onChange={(e) => set('copies', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
                <button type="button" className="secondary" aria-label="One copy more" disabled={specs.copies >= 100} onClick={() => set('copies', Math.min(100, specs.copies + 1))}>+</button>
              </div>
            </div>

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

            <Choice
              label="Pages"
              value={pageMode}
              options={[{ value: 'all', label: pages ? `All ${pages}` : 'All' }, { value: 'custom', label: 'Choose pages' }]}
              onChange={(v) => setPageMode(v)}
            />
            {pageMode === 'custom' && (
              <div className="page-range">
                {rangeAdvanced ? (
                  <>
                    <label htmlFor="advanced-range">Page numbers or ranges</label>
                    <input id="advanced-range" type="text" placeholder="For example: 1-5, 8, 11-14" value={rawRange} onChange={(e) => setRawRange(e.target.value)} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? 'range-error' : undefined} autoFocus />
                    <button type="button" className="quiet" onClick={() => setRangeAdvanced(false)}>Use from and to</button>
                  </>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="field grow"><label htmlFor="rfrom">From page</label><input id="rfrom" type="number" inputMode="numeric" min={1} max={pages ?? 1} value={rangeFrom} onChange={(e) => setRangeFrom(Math.max(1, Number(e.target.value) || 1))} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? 'range-error' : undefined} /></div>
                      <div className="field grow"><label htmlFor="rto">To page</label><input id="rto" type="number" inputMode="numeric" min={1} max={pages ?? 1} value={rangeTo} onChange={(e) => setRangeTo(Math.max(1, Number(e.target.value) || 1))} aria-invalid={rangeError ? true : undefined} aria-describedby={rangeError ? 'range-error' : undefined} /></div>
                    </div>
                    <button type="button" className="quiet" onClick={() => setRangeAdvanced(true)}>Need separate ranges?</button>
                  </>
                )}
                {rangeError && <p id="range-error" className="field-error" role="alert">{rangeError}</p>}
              </div>
            )}
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
                  <button type="submit" className="secondary" disabled={!couponInput.trim()}>Apply</button>
                </form>
                {couponError && <p className="field-error" role="alert">{couponError}</p>}
              </details>
            )}
          </section>
        </div>

        <aside className="checkout-side">
          <div className="preview-card">
            <div className="preview-card-head"><strong>Preview</strong><span>{pages ? `${pages} pages` : 'Preparing…'}</span></div>
            <Suspense fallback={<div className="pdf-status" role="status">Preparing preview…</div>}>
              <PdfPreview fileId={fileId} totalPages={pages} pageRange={specs.pageRange} />
            </Suspense>
          </div>

          <div className="checkout-bar">
            {(unsupported.length > 0 || error) && (
              <div className="bar-alert" role="alert">
                {unsupported.map((u) => <p key={u.code}>{u.message}</p>)}
                {error && <p>{error}</p>}
              </div>
            )}
            <div className="bar-total" aria-live="polite">
              <span className="bar-label">Total{totalPages ? ` · ${totalPages} page${totalPages === 1 ? '' : 's'}` : ''}</span>
              <strong className="num" aria-busy={!quote && !quoteFailed}>
                {quote ? rupees(quote.totalPaise) : quoteFailed ? 'Unavailable' : <span className="total-loading">Updating…</span>}
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
