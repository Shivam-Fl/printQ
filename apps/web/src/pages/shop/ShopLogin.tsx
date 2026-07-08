import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setShopRole, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

type Mode = 'password' | 'pin' | 'forgot-request' | 'forgot-confirm';

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
      <div className="page">
        <Topbar tag="shop counter" />
        <h1>Reset password</h1>
        <div className="card stack">
          <div>
            <label htmlFor="remail">Email</label>
            <input id="remail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
          <button disabled={busy || !email} onClick={requestReset}>
            {busy ? 'Sending…' : 'Send reset code'}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
        <p className="dim">
          <button className="ghost small" onClick={() => setMode('password')}>← Back to sign in</button>
        </p>
      </div>
    );
  }

  if (mode === 'forgot-confirm') {
    return (
      <div className="page">
        <Topbar tag="shop counter" />
        <h1>Enter your code</h1>
        {message && <p className="dim">{message}</p>}
        <div className="card stack">
          <div>
            <label htmlFor="rotp">6-digit code</label>
            <input
              id="rotp"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
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
            />
          </div>
          <button disabled={busy || otp.length !== 6 || newPassword.length < 8} onClick={confirmReset}>
            {busy ? 'Saving…' : 'Reset password'}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
        <p className="dim">
          <button className="ghost small" onClick={() => setMode('forgot-request')}>← Send a new code</button>
        </p>
      </div>
    );
  }

  return (
    <div className="page">
      <Topbar tag="shop counter" />
      <h1>Sign in</h1>
      {message && <p className="dim">{message}</p>}
      <div className="card stack">
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
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
            />
          </div>
        )}
        <button
          disabled={busy || !email || (mode === 'pin' ? pin.length < 4 : !password)}
          onClick={() =>
            mode === 'pin'
              ? login('/api/auth/shop/staff-login', { email, pin })
              : login('/api/auth/shop/login', { email, password })
          }
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="error">{error}</div>}
        <div className="row between">
          <button className="ghost small" onClick={() => setMode(mode === 'pin' ? 'password' : 'pin')}>
            {mode === 'pin' ? 'Use password instead' : 'Staff? Use your PIN'}
          </button>
          {mode === 'password' && (
            <button className="ghost small" onClick={() => setMode('forgot-request')}>Forgot password?</button>
          )}
        </div>
      </div>
      <p className="dim">
        New shop? <Link to="/dashboard/register">Register in 2 minutes →</Link>
      </p>
    </div>
  );
}
