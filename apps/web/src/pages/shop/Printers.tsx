import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, getToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

interface Printer {
  id: string;
  label: string;
  paperSizesLoaded: string[];
  colorSupport: boolean;
  finishingOptions: string[];
  avgPagesPerMinute: number;
  status: 'online' | 'offline' | 'jammed';
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

export default function Printers() {
  const navigate = useNavigate();
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [shop, setShop] = useState<ShopSettings | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
        api<{ shop: ShopSettings }>('/api/shop/me', { role: 'shop' }),
      ]);
      setPrinters(p.printers);
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
      <Topbar tag="printers" right={<Link to="/dashboard">← Dashboard</Link>} />

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
        <h2>Printers ({printers.length})</h2>
        <button className="small" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : '+ Add printer'}
        </button>
      </div>

      {showForm && (
        <div className="card stack">
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
            <tr><th>Label</th><th>Paper</th><th>Colour</th><th>Finishing</th><th>Speed</th><th>Status</th></tr>
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
