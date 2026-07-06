import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

export default function ShopRegister() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    shopName: '',
    address: '',
    campusName: '',
    ownerName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [studentLink, setStudentLink] = useState('');

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  async function register() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; shop: { slug: string } }>('/api/auth/shop/register', {
        method: 'POST',
        body: { ...form, campusName: form.campusName || undefined },
      });
      setToken('shop', res.token);
      setStudentLink(`${window.location.origin}/s/${res.shop.slug}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  if (studentLink) {
    return (
      <div className="page">
        <Topbar tag="shop counter" />
        <div className="ticket">
          <div className="eyebrow">your shop is live</div>
          <div className="sub" style={{ margin: '8px 0' }}>
            Students order at this link — print it as a QR and stick it at the counter:
          </div>
          <div className="mono" style={{ wordBreak: 'break-all', fontWeight: 700 }}>{studentLink}</div>
        </div>
        <div className="stack">
          <button onClick={() => navigate('/dashboard/printers')}>Add your printers →</button>
          <button className="ghost" onClick={() => navigate('/dashboard')}>Go to dashboard</button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <Topbar tag="shop counter" />
      <h1>Register your shop</h1>
      <p className="dim">Free during the pilot. You'll add printers right after.</p>
      <div className="card stack">
        <div>
          <label htmlFor="shopName">Shop name</label>
          <input id="shopName" type="text" placeholder="Sharma Xerox & Prints" value={form.shopName} onChange={set('shopName')} />
        </div>
        <div>
          <label htmlFor="address">Address</label>
          <input id="address" type="text" placeholder="Gate 2, College Road" value={form.address} onChange={set('address')} />
        </div>
        <div>
          <label htmlFor="campus">Campus (optional)</label>
          <input id="campus" type="text" placeholder="ABC Engineering College" value={form.campusName} onChange={set('campusName')} />
        </div>
        <div>
          <label htmlFor="ownerName">Your name</label>
          <input id="ownerName" type="text" value={form.ownerName} onChange={set('ownerName')} />
        </div>
        <div>
          <label htmlFor="remail">Email</label>
          <input id="remail" type="email" value={form.email} onChange={set('email')} />
        </div>
        <div>
          <label htmlFor="rpass">Password (8+ characters)</label>
          <input id="rpass" type="password" value={form.password} onChange={set('password')} />
        </div>
        <button
          disabled={busy || !form.shopName || !form.address || !form.ownerName || !form.email || form.password.length < 8}
          onClick={register}
        >
          {busy ? 'Creating…' : 'Create shop'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
      <p className="dim">
        Already registered? <Link to="/dashboard/login">Sign in</Link>
      </p>
    </div>
  );
}
