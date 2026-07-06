import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { API_URL, api, getToken, rupees } from '../../api.js';
import { enablePush, pushPermission } from '../../push.js';
import Topbar from '../../components/Topbar.js';

interface Paper {
  id: string;
  label: string;
  bwPaise: number;
  colorPaise: number | null;
}
interface Binding {
  id: string;
  label: string;
  paise: number;
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
  pagesTotalPaise: number;
  bindingPaise: number;
  totalPaise: number;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

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
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const token = getToken('student');
  const previewUrl = `${API_URL}/api/files/${fileId}/preview?token=${encodeURIComponent(token ?? '')}`;

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

  const refreshQuote = useCallback(
    async (s: Specs) => {
      try {
        const res = await api<{ quote: Quote; pages: number }>('/api/jobs/quote', {
          method: 'POST',
          role: 'student',
          body: { fileId, specs: s },
        });
        setQuote(res.quote);
        setPages(res.pages);
        setError('');
      } catch (err) {
        setQuote(null);
        setError(err instanceof Error ? err.message : 'Could not price this job');
      }
    },
    [fileId],
  );

  useEffect(() => {
    if (!specs) return;
    const t = setTimeout(() => void refreshQuote(specs), 300);
    return () => clearTimeout(t);
  }, [specs, refreshQuote]);

  function set<K extends keyof Specs>(key: K, value: Specs[K]) {
    setSpecs((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  const paper = opts?.papers.find((p) => p.id === specs?.paperSize);
  const colorAvailable = paper?.colorPaise != null;

  // if the chosen paper can't do colour, force B/W
  useEffect(() => {
    if (specs?.color && !colorAvailable) set('color', false);
  }, [specs?.paperSize]); // eslint-disable-line react-hooks/exhaustive-deps

  async function payAndQueue() {
    if (!specs) return;
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = { fileId, specs, mode };
      if (mode === 'scheduled') body.scheduledTime = new Date(slot).toISOString();
      const res = await api<{
        job: { id: string };
        checkout: { mode: 'mock' | 'razorpay'; keyId?: string; orderId?: string; amountPaise?: number };
      }>('/api/jobs', { method: 'POST', role: 'student', body });

      if (pushPermission() === 'default') void enablePush();

      if (res.checkout.mode === 'mock') {
        await api('/api/payments/mock/confirm', { method: 'POST', role: 'student', body: { jobId: res.job.id } });
        navigate(`/jobs/${res.job.id}`);
        return;
      }
      await loadRazorpay();
      const rzp = new window.Razorpay!({
        key: res.checkout.keyId,
        order_id: res.checkout.orderId,
        amount: res.checkout.amountPaise,
        currency: 'INR',
        name: 'PrintQ',
        handler: () => navigate(`/jobs/${res.job.id}`),
        modal: { ondismiss: () => navigate(`/jobs/${res.job.id}`) },
      });
      rzp.open();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Payment failed');
    } finally {
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
      <h1>Set your print</h1>
      <p className="dim">This preview is exactly what will print{pages ? ` · ${pages} pages` : ''}.</p>
      <iframe className="preview-frame" src={previewUrl} title="Print preview" />

      <div className="card stack">
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="copies">Copies</label>
            <input
              id="copies"
              type="number"
              inputMode="numeric"
              min={1}
              max={100}
              value={specs.copies}
              onChange={(e) => set('copies', Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="paper">Paper</label>
            <select id="paper" value={specs.paperSize} onChange={(e) => set('paperSize', e.target.value)}>
              {opts.papers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {rupees(p.bwPaise)}/pg
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label htmlFor="color">Colour</label>
            <select
              id="color"
              value={specs.color ? 'color' : 'bw'}
              disabled={!colorAvailable}
              onChange={(e) => set('color', e.target.value === 'color')}
            >
              <option value="bw">Black &amp; white</option>
              {colorAvailable && <option value="color">Colour — {rupees(paper!.colorPaise!)}/pg</option>}
            </select>
          </div>
          {opts.duplexEnabled && (
            <div style={{ flex: 1 }}>
              <label htmlFor="sides">Sides</label>
              <select id="sides" value={specs.duplex ? 'duplex' : 'single'} onChange={(e) => set('duplex', e.target.value === 'duplex')}>
                <option value="single">One-sided</option>
                <option value="duplex">Both sides</option>
              </select>
            </div>
          )}
        </div>
        <div className="row">
          {opts.bindings.length > 0 && (
            <div style={{ flex: 1 }}>
              <label htmlFor="binding">Binding</label>
              <select
                id="binding"
                value={specs.binding ?? 'none'}
                onChange={(e) => set('binding', e.target.value === 'none' ? null : e.target.value)}
              >
                <option value="none">None</option>
                {opts.bindings.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                    {b.paise > 0 ? ` — ${rupees(b.paise)}` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ flex: 1 }}>
            <label htmlFor="range">Pages (optional)</label>
            <input
              id="range"
              type="text"
              placeholder="e.g. 1-5,8"
              value={specs.pageRange ?? ''}
              onChange={(e) => set('pageRange', e.target.value.trim() === '' ? null : e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card stack">
        <div className="seg" role="radiogroup" aria-label="When to print">
          <button className={mode === 'instant' ? 'on' : ''} onClick={() => setMode('instant')}>Print now</button>
          <button className={mode === 'scheduled' ? 'on' : ''} onClick={() => setMode('scheduled')}>Pick a slot</button>
        </div>
        {mode === 'instant' ? (
          <p className="dim" style={{ margin: 0 }}>You join the live queue the moment payment is done.</p>
        ) : (
          <div>
            <label htmlFor="slot">Print at</label>
            <input id="slot" type="datetime-local" value={slot} min={minSlot} max={maxSlot} onChange={(e) => setSlot(e.target.value)} />
            <p className="dim" style={{ marginBottom: 0 }}>Book tonight, walk in tomorrow — your spot is reserved.</p>
          </div>
        )}
      </div>

      <div className="card">
        {quote ? (
          <div className="receipt">
            <div className="line">
              <span>{quote.pagesPerCopy} pages × {specs.copies} {specs.copies === 1 ? 'copy' : 'copies'}</span>
              <span>{rupees(quote.pagesTotalPaise)}</span>
            </div>
            {quote.bindingPaise > 0 && (
              <div className="line"><span>binding</span><span>{rupees(quote.bindingPaise)}</span></div>
            )}
            <div className="line total"><span>Total</span><span>{rupees(quote.totalPaise)}</span></div>
          </div>
        ) : (
          <p className="dim" style={{ margin: 0 }}>Pricing…</p>
        )}
        <button style={{ width: '100%', marginTop: 14 }} disabled={!quote || busy} onClick={payAndQueue}>
          {busy ? 'Starting…' : mode === 'scheduled' ? 'Pay & book slot' : 'Pay & join queue'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <p className="dim"><a href={`/s/${slug}`}>← choose different files</a></p>
    </div>
  );
}

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load payment window'));
    document.body.appendChild(script);
  });
}
