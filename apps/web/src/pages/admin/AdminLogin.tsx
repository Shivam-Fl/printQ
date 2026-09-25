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
  const [recovery, setRecovery] = useState<'login' | 'request' | 'confirm'>('login');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [notice, setNotice] = useState('');

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

  async function requestReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/auth/request-reset', { method: 'POST', body: { email } });
      setNotice('If this is an active platform-admin account, a reset code has been sent.');
      setRecovery('confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not request a reset code.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/admin/auth/reset-password', { method: 'POST', body: { email, otp: code, newPassword } });
      setCode('');
      setNewPassword('');
      setNotice('Password updated. Sign in with your new password.');
      setRecovery('login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset password.');
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
        {notice && <p role="status">{notice}</p>}
        {recovery === 'login' && <form className="stack" onSubmit={submit}>
          <div className="field"><label htmlFor="admin-email">Email</label><input id="admin-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required /></div>
          <div className="field"><label htmlFor="admin-password">Password</label><input id="admin-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /></div>
          {error && <p className="error">{error}</p>}
          <button className="button-link" disabled={busy}>{busy ? 'Signing in…' : 'Sign in securely'}</button>
        </form>
        }
        {recovery === 'request' && <form className="stack" onSubmit={requestReset}>
          <div className="field"><label htmlFor="admin-recovery-email">Platform email</label><input id="admin-recovery-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></div>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button-link" disabled={busy}>{busy ? 'Sending…' : 'Send reset code'}</button>
        </form>}
        {recovery === 'confirm' && <form className="stack" onSubmit={confirmReset}>
          <div className="field"><label htmlFor="admin-reset-code">6-digit code</label><input id="admin-reset-code" type="text" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(event) => setCode(event.target.value)} autoComplete="one-time-code" required /></div>
          <div className="field"><label htmlFor="admin-new-password">New password</label><input id="admin-new-password" type="password" minLength={12} maxLength={128} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" required /></div>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button-link" disabled={busy}>{busy ? 'Updating…' : 'Set new password'}</button>
        </form>}
        {recovery === 'login' ? <button type="button" className="text-button" onClick={() => { setError(''); setNotice(''); setRecovery('request'); }}>Forgot password?</button>
          : <button type="button" className="text-button" onClick={() => { setError(''); setRecovery('login'); }}>Back to sign in</button>}
      </section>
    </main>
  );
}
