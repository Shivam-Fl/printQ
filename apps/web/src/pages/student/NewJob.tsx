import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { API_URL, api, getToken, rupees } from '../../api.js';

interface Specs {
  copies: number;
  paperSize: 'A4' | 'A3';
  color: boolean;
  duplex: boolean;
  binding: 'stapling' | 'spiral_binding' | null;
  pageRange: string | null;
}

interface Quote {
  pagesPerCopy: number;
  totalPaise: number;
  bindingPaise: number;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

export default function NewJob() {
  const { slug = '', fileId = '' } = useParams();
  const navigate = useNavigate();
  const [specs, setSpecs] = useState<Specs>({
    copies: 1,
    paperSize: 'A4',
    color: false,
    duplex: false,
    binding: null,
    pageRange: null,
  });
  const [pages, setPages] = useState<number | null>(null);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const token = getToken('student');
  const previewUrl = `${API_URL}/api/files/${fileId}/preview?token=${encodeURIComponent(token ?? '')}`;

  const refreshQuote = useCallback(async (s: Specs) => {
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
  }, [fileId]);

  useEffect(() => {
    const t = setTimeout(() => void refreshQuote(specs), 300);
    return () => clearTimeout(t);
  }, [specs, refreshQuote]);

  function set<K extends keyof Specs>(key: K, value: Specs[K]) {
    setSpecs((prev) => ({ ...prev, [key]: value }));
  }

  async function payAndQueue() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{
        job: { id: string };
        checkout: { mode: 'mock' | 'razorpay'; keyId?: string; orderId?: string; amountPaise?: number };
      }>('/api/jobs', { method: 'POST', role: 'student', body: { fileId, specs } });

      if (res.checkout.mode === 'mock') {
        await api('/api/payments/mock/confirm', {
          method: 'POST',
          role: 'student',
          body: { jobId: res.job.id },
        });
        navigate(`/jobs/${res.job.id}`);
        return;
      }

      // Razorpay checkout — confirmation still comes via the server webhook;
      // this page just opens the payment UI and then watches the job status.
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

  return (
    <div className="page">
      <div className="topbar">
        <span className="brand">PrintQ</span>
      </div>
      <h1>Set your print</h1>
      <p className="dim">This preview is exactly what will print{pages ? ` · ${pages} pages` : ''}.</p>
      <iframe className="preview-frame" src={previewUrl} title="Print preview" />

      <div className="card stack">
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Copies</label>
            <input
              type="number"
              min={1}
              max={100}
              value={specs.copies}
              onChange={(e) => set('copies', Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label>Paper size</label>
            <select value={specs.paperSize} onChange={(e) => set('paperSize', e.target.value as Specs['paperSize'])}>
              <option value="A4">A4</option>
              <option value="A3">A3</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Colour</label>
            <select value={specs.color ? 'color' : 'bw'} onChange={(e) => set('color', e.target.value === 'color')}>
              <option value="bw">Black &amp; white</option>
              <option value="color">Colour</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Sides</label>
            <select value={specs.duplex ? 'duplex' : 'single'} onChange={(e) => set('duplex', e.target.value === 'duplex')}>
              <option value="single">Single-sided</option>
              <option value="duplex">Double-sided</option>
            </select>
          </div>
        </div>
        <div className="row">
          <div style={{ flex: 1 }}>
            <label>Binding</label>
            <select
              value={specs.binding ?? 'none'}
              onChange={(e) => set('binding', e.target.value === 'none' ? null : (e.target.value as Specs['binding']))}
            >
              <option value="none">None</option>
              <option value="stapling">Stapling</option>
              <option value="spiral_binding">Spiral binding</option>
            </select>
          </div>
          <div style={{ flex: 1 }}>
            <label>Pages (optional)</label>
            <input
              type="text"
              placeholder="e.g. 1-5,8"
              value={specs.pageRange ?? ''}
              onChange={(e) => set('pageRange', e.target.value.trim() === '' ? null : e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card row between">
        <div>
          <div className="dim">Total</div>
          <div style={{ fontSize: '1.6rem', fontWeight: 700 }}>
            {quote ? rupees(quote.totalPaise) : '—'}
          </div>
          {quote && (
            <div className="dim">
              {quote.pagesPerCopy} pages × {specs.copies} {specs.copies === 1 ? 'copy' : 'copies'}
              {quote.bindingPaise > 0 ? ` + binding ${rupees(quote.bindingPaise)}` : ''}
            </div>
          )}
        </div>
        <button disabled={!quote || busy} onClick={payAndQueue}>
          {busy ? 'Starting…' : 'Pay & join queue'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <p className="dim">
        <a href={`/s/${slug}`}>← choose a different file</a>
      </p>
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
