import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../../api.js';

export default function ShopLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function login() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string }>('/api/auth/shop/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken('shop', res.token);
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="topbar"><span className="brand">PrintQ · Shop</span></div>
      <h1>Staff login</h1>
      <div className="card stack">
        <div>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div>
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void login()}
          />
        </div>
        <button disabled={busy || !email || !password} onClick={login}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="error">{error}</div>}
      </div>
    </div>
  );
}
