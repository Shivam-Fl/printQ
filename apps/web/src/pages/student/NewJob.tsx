import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { parsePageRange } from '@printq/shared';
import { ApiError, api, rupees } from '../../api.js';
import { createLatestRequest, isAbortError } from '../../lib/latestRequest.js';
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

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function NewJob() {
  const { slug = '', fileId = '' } = useParams();
  const navigate = useNavigate();
  const [opts, setOpts] = useState<ShopOptions | null>(null);
  const [specs, setSpecs] = useState<Specs | null>(null);
  const [mode, setMode] = useState<'instant' | 'scheduled'>('instant');
  const [slot, setSlot] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60_000)));
  const [pages, setPages] = useState<number | null>(null);
  const [quoted, setQuoted] = useState<{ key: string; quote: Quote; unsupported?: { code: string; message: string }[] } | null>(null);
  const [quoteErrorKey, setQuoteErrorKey] = useState<string | null>(null);
  const [error, setError] = useState('');
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

  // load the shop's offered options and seed defaults
  useEffect(() => {
    api<{ shop: { options: ShopOptions } }>(`/api/public/shops/${slug}`)
      .then((r) => {
        setOpts(r.shop.options);
        const p0 = r.shop.options.papers[0];
        setSpecs({
          copies: 1,
          paperSize: p0?.id ?? 'A4',
          color: false,
          duplex: false,
          binding: null,
          pageRange: null,
        });
      })
      .catch(() => setError('Could not load this shop.'));
  }, [slug]);

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
          setError(err instanceof Error ? err.message : 'Could not price this job');
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
      setCouponError(err instanceof Error ? err.message : 'Invalid coupon');
    }
  }

  function set<K extends keyof Specs>(key: K, value: Specs[K]) {
    setSpecs((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const paper = opts?.papers.find((p) => p.id === specs?.paperSize);
  const colorAvailable = Boolean(paper?.colorAvailable);

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
      setRangeError('Enter a page range');
      return;
    }
    if (!pages) return;
    try {
      parsePageRange(candidate, pages);
      setRangeError('');
      set('pageRange', candidate === `1-${pages}` ? null : candidate);
    } catch (err) {
      setRangeError(err instanceof Error ? err.message : 'Invalid page range');
    }
  }, [pageMode, rangeAdvanced, rangeFrom, rangeTo, rawRange, pages]); // eslint-disable-line react-hooks/exhaustive-deps

  async function payAndQueue() {
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

      if (pushPermission() === 'default') void enablePush();

      navigate(`/jobs/${res.job.id}`);
    } catch (err) {
      // A real answer ends this attempt; a network failure keeps the key so a
      // retry cannot create a second order if the first one actually landed.
      if (err instanceof ApiError) idemKey.current = crypto.randomUUID();
      setError(err instanceof Error ? err.message : 'Could not prepare the order');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!opts || !specs) {
    return (
      <div className="page">
        <Topbar />
        <p className="dim">Loading…</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const minSlot = toLocalInput(new Date(Date.now() + 20 * 60_000));
  const maxSlot = toLocalInput(new Date(Date.now() + 72 * 3_600_000));

  return (
    <div className="page">
      <Topbar />
      <div className="checkout-heading">
        <span className="eyebrow-label">Review before you visit</span>
        <h1>Set up your print</h1>
        <p className="dim">Check the preview and choose only what you need. The total updates instantly.</p>
        <div className="checkout-steps" aria-label="Order progress">
          <span className="done">Files uploaded</span><span className="current">Print settings</span><span>Pay at shop</span><span>Arrive &amp; check in</span>
        </div>
      </div>

      <div className="checkout-grid">
        <div className="checkout-main">
          <section className="checkout-card">
            <div className="checkout-card-head">
              <h2>Print settings</h2>
              <p>Paper, copies and finish.</p>
            </div>
            <div className="form-row">
              <div className="field grow">
                <label htmlFor="copies">Copies</label>
                <input id="copies" type="number" inputMode="numeric" min={1} max={100} value={specs.copies} onChange={(e) => set('copies', Math.max(1, Math.min(100, Number(e.target.value) || 1)))} />
              </div>
              <div className="field grow">
                <label htmlFor="paper">Paper</label>
                <select id="paper" value={specs.paperSize} onChange={(e) => set('paperSize', e.target.value)}>
                  {opts.papers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="field grow">
                <label htmlFor="color">Ink</label>
                <select id="color" value={specs.color ? 'color' : 'bw'} disabled={!colorAvailable} onChange={(e) => set('color', e.target.value === 'color')}>
                  <option value="bw">Black &amp; white</option>
                  {colorAvailable && <option value="color">Colour</option>}
                </select>
              </div>
              {opts.duplexEnabled && (
                <div className="field grow">
                  <label htmlFor="sides">Sides</label>
                  <select id="sides" value={specs.duplex ? 'duplex' : 'single'} onChange={(e) => set('duplex', e.target.value === 'duplex')}>
                    <option value="single">One-sided</option><option value="duplex">Both sides</option>
                  </select>
                </div>
              )}
            </div>
            {opts.bindings.length > 0 && (
              <div className="field">
                <label htmlFor="binding">Binding or finishing</label>
                <select id="binding" value={specs.binding ?? 'none'} onChange={(e) => set('binding', e.target.value === 'none' ? null : e.target.value)}>
                  <option value="none">None</option>
                  {opts.bindings.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
              </div>
            )}
          </section>

          <section className="checkout-card">
            <div className="checkout-card-head">
              <h2>Pages</h2>
              <p>Print the whole document or only selected pages.</p>
            </div>
            <div className="seg" role="radiogroup" aria-label="Which pages">
              <button className={pageMode === 'all' ? 'on' : ''} onClick={() => setPageMode('all')}>All {pages ? `${pages} pages` : 'pages'}</button>
              <button className={pageMode === 'custom' ? 'on' : ''} onClick={() => setPageMode('custom')}>Choose pages</button>
            </div>
            {pageMode === 'custom' && (
              <div style={{ marginTop: 14 }}>
                {rangeAdvanced ? (
                  <>
                    <label htmlFor="advanced-range">Page numbers or ranges</label>
                    <input id="advanced-range" type="text" placeholder="For example: 1-5, 8, 11-14" value={rawRange} onChange={(e) => setRawRange(e.target.value)} autoFocus />
                    <button className="text-button" style={{ marginTop: 7 }} onClick={() => setRangeAdvanced(false)}>Use simple from/to fields</button>
                  </>
                ) : (
                  <>
                    <div className="form-row">
                      <div className="field grow"><label htmlFor="rfrom">From page</label><input id="rfrom" type="number" inputMode="numeric" min={1} max={pages ?? 1} value={rangeFrom} onChange={(e) => setRangeFrom(Math.max(1, Number(e.target.value) || 1))} /></div>
                      <div className="field grow"><label htmlFor="rto">To page</label><input id="rto" type="number" inputMode="numeric" min={1} max={pages ?? 1} value={rangeTo} onChange={(e) => setRangeTo(Math.max(1, Number(e.target.value) || 1))} /></div>
                    </div>
                    <button className="text-button" style={{ marginTop: 7 }} onClick={() => setRangeAdvanced(true)}>Need separate ranges?</button>
                  </>
                )}
                {rangeError && <div className="error-box" role="alert">{rangeError}</div>}
              </div>
            )}
          </section>

          <section className="checkout-card">
            <div className="checkout-card-head"><h2>When do you plan to arrive?</h2><p>Your live queue position starts only after you reach the shop and check in.</p></div>
            <div className="seg" role="radiogroup" aria-label="When to print">
              <button className={mode === 'instant' ? 'on' : ''} onClick={() => setMode('instant')}>Flexible arrival</button>
              <button className={mode === 'scheduled' ? 'on' : ''} onClick={() => setMode('scheduled')}>Reserve a time</button>
            </div>
            {mode === 'instant' ? <p className="dim" style={{ marginBottom: 0 }}>Your position appears only after you arrive and check in.</p> : (
              <div style={{ marginTop: 14 }}><label htmlFor="slot">Planned arrival</label><input id="slot" type="datetime-local" value={slot} min={minSlot} max={maxSlot} onChange={(e) => setSlot(e.target.value)} /><p className="dim" style={{ marginBottom: 0 }}>We’ll remind you near this time. Check-in still starts only when you are physically there.</p></div>
            )}
          </section>

          <section className="checkout-card">
            <div className="checkout-card-head"><h2>Pay at shop</h2><p>Pay the final total shown below directly to the shop by cash or the shop’s merchant UPI. Staff verifies receipt before printing.</p></div>
            <div className="payment-method on" aria-label="Payment method">
              <strong>Pay at shop</strong>
              <span>Cash or the shop’s own UPI at the counter</span>
            </div>
          </section>
        </div>

        <aside className="checkout-sidebar">
          <div className="preview-card">
            <div className="preview-card-head"><strong>Print preview</strong><span>{pages ? `${pages} pages` : 'Preparing…'}</span></div>
            <Suspense fallback={<div className="pdf-status" role="status">Preparing preview…</div>}>
              <PdfPreview fileId={fileId} totalPages={pages} pageRange={specs.pageRange} />
            </Suspense>
          </div>
          <div className="checkout-total">
            <div className="receipt" aria-busy={!quote && !quoteFailed}>
              <div className="line">
                <span>Selected print</span>
                <span>{quote ? `${quote.pagesPerCopy * specs.copies} pages` : <span className="total-loading" aria-hidden>···</span>}</span>
              </div>
              <div className="line total">
                <span>Total to pay</span>
                <span aria-live="polite">
                  {quote ? rupees(quote.totalPaise)
                    : quoteFailed ? <span>Unavailable</span>
                    : <span className="total-loading" role="status">Updating…</span>}
                </span>
              </div>
            </div>

            {unsupported.length > 0 && (
              <div className="error-box" role="alert" data-testid="unsupported-options" style={{ marginTop: 12 }}>
                {unsupported.map((u) => <p key={u.code} style={{ margin: 0 }}>{u.message}</p>)}
              </div>
            )}
            {appliedCoupon ? (
              <p style={{ margin: '12px 0 0', color: '#b9c2d2', fontSize: '.82rem' }}>Coupon <strong className="mono">{appliedCoupon}</strong> applied. <button className="text-button" onClick={() => { setAppliedCoupon(null); setCouponInput(''); }}>Remove</button></p>
            ) : (
              <div className="row" style={{ marginTop: 12, flexWrap: 'nowrap' }}>
                <input type="text" aria-label="Coupon code" placeholder="Coupon code" value={couponInput} onChange={(e) => setCouponInput(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && void applyCoupon()} style={{ flex: 1 }} />
                <button className="ghost small" disabled={!couponInput.trim()} onClick={applyCoupon}>Apply</button>
              </div>
            )}
            {couponError && <p className="error" style={{ marginBottom: 0 }}>{couponError}</p>}
            <button className="full-button" style={{ marginTop: 16 }} disabled={!quote || busy || !!rangeError || unsupported.length > 0} onClick={payAndQueue}>
              {busy
                ? 'Preparing order…'
                : !quote && !quoteFailed ? 'Updating total…'
                : mode === 'scheduled' ? 'Prepare order & save arrival time' : 'Prepare order'}
            </button>
            <p style={{ margin: '10px 0 0', color: '#939fb5', fontSize: '.7rem', textAlign: 'center' }}>
              Pay the final total shown above at the counter · status notifications
            </p>
          </div>
        </aside>
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      <p className="dim"><a href={`/s/${slug}`}>← Choose different files</a></p>
    </div>
  );
}
