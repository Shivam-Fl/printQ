import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setShopRole, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';
import { reverseLabel } from '../../lib/geocode.js';
import { stashRegisterPin } from '../../lib/locationFlow.js';

export default function ShopRegister() {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    shopName: '',
    address: '',
    ownerName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState('');
  /** Coordinates from "Fill from my location", handed to the pin step so it does not ask again. */
  const coords = useRef<{ latitude: number; longitude: number } | null>(null);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm({ ...form, [key]: e.target.value });

  /** Optional convenience: fill the address from this device's location (asks permission on click only). */
  function fillAddressFromDevice() {
    if (!navigator.geolocation) {
      setLocateNote('This device cannot share its location. Type the address instead.');
      return;
    }
    setLocating(true);
    setLocateNote('');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const latitude = Number(position.coords.latitude.toFixed(6));
        const longitude = Number(position.coords.longitude.toFixed(6));
        coords.current = { latitude, longitude };
        const label = await reverseLabel(latitude, longitude);
        if (label) setForm((current) => ({ ...current, address: label }));
        else setLocateNote('Could not find an address here. Type it in; you will pin the exact spot next.');
        setLocating(false);
      },
      () => {
        setLocateNote('Location is off. Type the address instead; you will pin the exact spot next.');
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  async function register() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; shop: { slug: string } }>('/api/auth/shop/register', {
        method: 'POST',
        body: form,
      });
      setToken('shop', res.token);
      setShopRole('owner');
      if (coords.current) stashRegisterPin(coords.current.latitude, coords.current.longitude);
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
          <p>Five fields and about three minutes. Any shop can join, on a campus or not.</p>
        </div>
        <div className="auth-card register-card stack">
          <div className="auth-form-grid">
            <div className="field grow">
              <label htmlFor="shopName">Shop name</label>
              <input id="shopName" type="text" placeholder="Sharma Xerox & Prints" value={form.shopName} onChange={set('shopName')} autoComplete="organization" autoFocus />
            </div>
            <div className="field full-field">
              <label htmlFor="address">Counter address</label>
              <input id="address" type="text" placeholder="12 Market Road, near the bus stand" value={form.address} onChange={set('address')} autoComplete="street-address" />
              <span className="field-help">
                <button type="button" className="ghost small" onClick={fillAddressFromDevice} disabled={locating}>
                  {locating ? 'Finding your address…' : 'Fill from my location'}
                </button>
                {locateNote && <span role="status"> {locateNote}</span>}
              </span>
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
          <h2>Live in four steps.</h2>
          <ol>
            <li><span>1</span><div><strong>Confirm your location</strong><p>We find it for you; drag the pin to your entrance.</p></div></li>
            <li><span>2</span><div><strong>Check your prices</strong><p>Sensible defaults are already filled in.</p></div></li>
            <li><span>3</span><div><strong>Connect the counter PC</strong><p>Paste one secure command, or use the PrintQ desktop app.</p></div></li>
            <li><span>4</span><div><strong>You are live</strong><p>Students nearby can find you as soon as your PC is connected.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
