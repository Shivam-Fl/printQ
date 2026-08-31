import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setShopRole, setToken } from '../../api.js';
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
      setShopRole('owner');
      navigate('/dashboard/setup', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page shop-auth-page register-page">
      <div className="auth-page-main">
        <Topbar tag="shop counter" />
        <div className="auth-copy">
          <span className="eyebrow-label">Get your counter online</span>
          <h1>Set up your shop.</h1>
          <p>Create the owner account now. A guided checklist will help you connect and test a printer next.</p>
        </div>
        <div className="auth-card register-card stack">
          <div className="auth-form-grid">
            <div className="field grow">
              <label htmlFor="shopName">Shop name</label>
              <input id="shopName" type="text" placeholder="Sharma Xerox & Prints" value={form.shopName} onChange={set('shopName')} autoComplete="organization" autoFocus />
            </div>
            <div className="field grow">
              <label htmlFor="campus">Campus <span className="optional-label">optional</span></label>
              <input id="campus" type="text" placeholder="ABC Engineering College" value={form.campusName} onChange={set('campusName')} />
            </div>
            <div className="field full-field">
              <label htmlFor="address">Counter address</label>
              <input id="address" type="text" placeholder="Gate 2, College Road" value={form.address} onChange={set('address')} autoComplete="street-address" />
            </div>
            <div className="field grow">
              <label htmlFor="ownerName">Owner name</label>
              <input id="ownerName" type="text" placeholder="Your full name" value={form.ownerName} onChange={set('ownerName')} autoComplete="name" />
            </div>
            <div className="field grow">
              <label htmlFor="remail">Work email</label>
              <input id="remail" type="email" placeholder="owner@shop.com" value={form.email} onChange={set('email')} autoComplete="email" />
            </div>
            <div className="field full-field">
              <label htmlFor="rpass">Password</label>
              <input id="rpass" type="password" placeholder="At least 8 characters" value={form.password} onChange={set('password')} autoComplete="new-password" />
            </div>
          </div>
          <button className="full-button"
          disabled={busy || !form.shopName || !form.address || !form.ownerName || !form.email || form.password.length < 8}
          onClick={register}
          >
            {busy ? 'Creating your shop…' : 'Create shop & continue'}
          </button>
          {error && <div className="error-box" role="alert">{error}</div>}
          <p className="form-footnote">By creating an account, you confirm that you’re authorised to manage this shop’s pricing and printers.</p>
        </div>
        <p className="dim auth-after-card">Already registered? <Link to="/dashboard/login">Sign in →</Link></p>
      </div>
      <aside className="auth-aside shop-auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">Launch checklist</span>
          <h2>You can test the entire setup without a physical printer.</h2>
          <ol>
            <li><span>1</span><div><strong>Set your prices</strong><p>Choose paper, colour and finishing options.</p></div></li>
            <li><span>2</span><div><strong>Connect the counter PC</strong><p>Paste one secure command on the computer near your printer.</p></div></li>
            <li><span>3</span><div><strong>Run a simulation</strong><p>Prove arrival check-in, counter-code dispatch and printer recovery before going live.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
