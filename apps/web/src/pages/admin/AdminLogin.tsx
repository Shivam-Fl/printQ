import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';

export default function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await api<{ token: string }>('/api/admin/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      setToken('admin', result.token);
      navigate('/admin', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <Topbar />
      <section className="auth-card">
        <span className="eyebrow-label">PrintQs operations</span>
        <h1>Platform administration</h1>
        <p>Use a dedicated platform account. Shop and student credentials cannot access verification controls.</p>
        <form className="stack" onSubmit={submit}>
          <div className="field"><label htmlFor="admin-email">Email</label><input id="admin-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></div>
          <div className="field"><label htmlFor="admin-password">Password</label><input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></div>
          {error && <p className="error">{error}</p>}
          <button className="button-link" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
        </form>
      </section>
    </main>
  );
}
