import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

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
      <Topbar tag="shop counter" />
      <h1>Staff login</h1>
      <div className="card stack">
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
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
      <p className="dim">
        New shop? <Link to="/dashboard/register">Register in 2 minutes →</Link>
      </p>
    </div>
  );
}
