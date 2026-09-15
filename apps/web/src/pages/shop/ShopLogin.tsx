import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setShopRole, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

type Mode = 'password' | 'pin' | 'forgot-request' | 'forgot-confirm';

function ShopAuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth-page shop-auth-page">
      <div className="auth-page-main">
        <Topbar tag="shop counter" />
        <div className="auth-copy">
          <span className="eyebrow-label">PrintQ for shops</span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {children}
      </div>
      <aside className="auth-aside shop-auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">A calmer counter</span>
          <h2>Every order arrives configured and ready for payment or print.</h2>
          <ol>
            <li><span>1</span><div><strong>See who actually arrived</strong><p>Remote prepared orders stay separate from the physical walk-in line.</p></div></li>
            <li><span>2</span><div><strong>Enter one counter code</strong><p>Find the right file, collect cash when due, then print.</p></div></li>
            <li><span>3</span><div><strong>Hand it over</strong><p>Pickup, history and receipts stay in one place.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}

export default function ShopLogin() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function login(path: string, body: Record<string, string>) {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; user: { role: 'owner' | 'staff' } }>(path, {
        method: 'POST',
        body,
      });
      setToken('shop', res.token);
      setShopRole(res.user.role);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  async function requestReset() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/shop/request-reset', { method: 'POST', body: { email } });
      setMessage('If that email has an account, a reset code was sent.');
      setMode('forgot-confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send reset code');
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/shop/reset-password', {
        method: 'POST',
        body: { email, otp, newPassword },
      });
      setMessage('Password updated — sign in below.');
      setMode('password');
      setPassword('');
      setOtp('');
      setNewPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset password');
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'forgot-request') {
    return (
      <ShopAuthLayout title="Reset your password" subtitle="We’ll send a six-digit code to the owner email on this account.">
        <div className="auth-card stack">
          <div>
            <label htmlFor="remail">Owner email</label>
            <input id="remail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
          </div>
          <button className="full-button" disabled={busy || !email} onClick={requestReset}>
            {busy ? 'Sending…' : 'Send reset code'}
          </button>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="text-button" onClick={() => setMode('password')}>← Back to sign in</button>
        </div>
      </ShopAuthLayout>
    );
  }

  if (mode === 'forgot-confirm') {
    return (
      <ShopAuthLayout title="Choose a new password" subtitle="Enter the code from your email, then create a password you don’t use elsewhere.">
        <div className="auth-card stack">
          {message && <div className="notice success-notice"><span>{message}</span></div>}
          <div>
            <label htmlFor="rotp">6-digit code</label>
            <input
              id="rotp"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              autoComplete="one-time-code"
              className="otp-boxes"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="rnew">New password (8+ characters)</label>
            <input
              id="rnew"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <button className="full-button" disabled={busy || otp.length !== 6 || newPassword.length < 8} onClick={confirmReset}>
            {busy ? 'Saving…' : 'Reset password'}
          </button>
          {error && <div className="error-box" role="alert">{error}</div>}
          <button className="text-button" onClick={() => setMode('forgot-request')}>← Send a new code</button>
        </div>
      </ShopAuthLayout>
    );
  }

  return (
    <ShopAuthLayout title="Run your print queue." subtitle="Sign in to release jobs, watch every printer and keep the counter moving.">
      <div className="auth-card stack">
        {message && <div className="notice success-notice"><span>{message}</span></div>}
        <div>
          <label htmlFor="email">Work email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
        </div>
        {mode === 'pin' ? (
          <div>
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && void login('/api/auth/shop/staff-login', { email, pin })}
              autoComplete="current-password"
            />
          </div>
        ) : (
          <div>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void login('/api/auth/shop/login', { email, password })}
              autoComplete="current-password"
            />
          </div>
        )}
        <button className="full-button"
          disabled={busy || !email || (mode === 'pin' ? pin.length < 4 : !password)}
          onClick={() =>
            mode === 'pin'
              ? login('/api/auth/shop/staff-login', { email, pin })
              : login('/api/auth/shop/login', { email, password })
          }
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="auth-inline-actions">
          <button className="text-button" onClick={() => setMode(mode === 'pin' ? 'password' : 'pin')}>
            {mode === 'pin' ? 'Use password instead' : 'Staff? Use your PIN'}
          </button>
          {mode === 'password' && (
            <button className="text-button" onClick={() => setMode('forgot-request')}>Forgot password?</button>
          )}
        </div>
      </div>
      <p className="dim auth-after-card">
        New shop? <Link to="/dashboard/register">Register in 2 minutes →</Link>
      </p>
    </ShopAuthLayout>
  );
}
