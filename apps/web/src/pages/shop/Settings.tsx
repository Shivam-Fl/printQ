import { useEffect, useState } from 'react';
import { api, getToken } from '../../api.js';
import { useNavigate } from 'react-router-dom';
import ShopNav from '../../components/ShopNav.js';

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
interface Options {
  papers: Paper[];
  bindings: Binding[];
  duplexEnabled: boolean;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || `opt-${Date.now()}`;
const rupees = (paise: number | null) => (paise == null ? '' : (paise / 100).toFixed(2));
const toPaise = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v) * 100)));

export default function Settings() {
  const navigate = useNavigate();
  const [opts, setOpts] = useState<Options | null>(null);
  const [autoAssign, setAutoAssign] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ shop: { printOptions: Options; autoAssignEnabled: boolean } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        setOpts(r.shop.printOptions);
        setAutoAssign(r.shop.autoAssignEnabled);
      })
      .catch(() => navigate('/dashboard/login'));
  }, [navigate]);

  if (!opts) {
    return (
      <div className="page wide">
        <ShopNav />
        <p className="dim">Loading…</p>
      </div>
    );
  }

  const setPaper = (i: number, patch: Partial<Paper>) =>
    setOpts({ ...opts, papers: opts.papers.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  const setBinding = (i: number, patch: Partial<Binding>) =>
    setOpts({ ...opts, bindings: opts.bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });

  async function save() {
    if (!opts) return;
    // clean up: drop empty-label rows, ensure ids
    const papers = opts.papers
      .filter((p) => p.label.trim())
      .map((p) => ({ ...p, id: p.id || slug(p.label), bwPaise: p.bwPaise || 0 }));
    const bindings = opts.bindings.filter((b) => b.label.trim()).map((b) => ({ ...b, id: b.id || slug(b.label) }));
    if (papers.length === 0) {
      setError('Add at least one paper type.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api('/api/shop/me', {
        method: 'PATCH',
        role: 'shop',
        body: { printOptions: { papers, bindings, duplexEnabled: opts.duplexEnabled }, autoAssignEnabled: autoAssign },
      });
      setOpts({ papers, bindings, duplexEnabled: opts.duplexEnabled });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Only the owner can change settings');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page wide">
      <ShopNav />
      <h1>Settings</h1>
      <p className="dim">Set the paper types, binding and prices students see. Add a custom sheet (e.g. your college's answer sheet) as its own paper.</p>

      <div className="card row between">
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong>Auto-assign printers</strong>
          <p className="dim" style={{ margin: '4px 0 0' }}>On: the OTP sends each job to the best printer automatically. Off: you pick from a dropdown.</p>
        </div>
        <button className={autoAssign ? '' : 'ghost'} onClick={() => setAutoAssign((v) => !v)}>{autoAssign ? 'ON' : 'OFF'}</button>
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Paper types &amp; price</h2>
          <button className="small" onClick={() => setOpts({ ...opts, papers: [...opts.papers, { id: '', label: '', bwPaise: 200, colorPaise: null }] })}>+ Add paper</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>Leave the colour price blank if that paper is black &amp; white only.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 10, fontSize: '0.72rem', color: 'var(--pencil)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
          <span>Name</span><span>₹ B/W / page</span><span>₹ Colour / page</span><span></span>
        </div>
        {opts.papers.map((p, i) => (
          <div key={i} className="opt-row">
            <input type="text" placeholder="e.g. College sheet" value={p.label} onChange={(e) => setPaper(i, { label: e.target.value })} />
            <input type="number" min={0} step={0.5} value={rupees(p.bwPaise)} onChange={(e) => setPaper(i, { bwPaise: toPaise(e.target.value) ?? 0 })} />
            <input type="number" min={0} step={0.5} placeholder="—" value={rupees(p.colorPaise)} onChange={(e) => setPaper(i, { colorPaise: toPaise(e.target.value) })} />
            <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, papers: opts.papers.filter((_, idx) => idx !== i) })}>×</button>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Binding &amp; finishing</h2>
          <button className="small" onClick={() => setOpts({ ...opts, bindings: [...opts.bindings, { id: '', label: '', paise: 0 }] })}>+ Add binding</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>"None" is always offered. Add extras like stapling or spiral.</p>
        {opts.bindings.map((b, i) => (
          <div key={i} className="opt-row" style={{ gridTemplateColumns: '1.4fr 1fr auto' }}>
            <input type="text" placeholder="e.g. Spiral binding" value={b.label} onChange={(e) => setBinding(i, { label: e.target.value })} />
            <input type="number" min={0} step={1} value={rupees(b.paise)} onChange={(e) => setBinding(i, { paise: toPaise(e.target.value) ?? 0 })} />
            <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, bindings: opts.bindings.filter((_, idx) => idx !== i) })}>×</button>
          </div>
        ))}
      </div>

      <div className="card row between">
        <div>
          <strong>Offer double-sided printing</strong>
          <p className="dim" style={{ margin: '4px 0 0' }}>Let students choose one-sided or both sides.</p>
        </div>
        <button className={opts.duplexEnabled ? '' : 'ghost'} onClick={() => setOpts({ ...opts, duplexEnabled: !opts.duplexEnabled })}>{opts.duplexEnabled ? 'ON' : 'OFF'}</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save settings'}</button>
        {saved && <span className="stamp green">saved ✓</span>}
      </div>
      {error && <p className="error">{error}</p>}
      <p className="dim" style={{ marginTop: 8 }}>Note: a paper/binding only appears to students if a printer that's marked online has it loaded (set that on the Printers page).</p>
    </div>
  );
}
