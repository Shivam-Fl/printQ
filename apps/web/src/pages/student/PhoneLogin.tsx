import { useState } from 'react';
import { api, setToken } from '../../api.js';

type Stage = 'phone' | 'otp' | 'name';

/** Phone-OTP login with a name step on first sign-in. Reused inline + on /login. */
export default function PhoneLogin({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function requestOtp() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/student/request-otp', { method: 'POST', body: { phone } });
      setStage('otp');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setBusy(true);
    setError('');
    try {
      const res = await api<{ token: string; student: { name: string | null } }>(
        '/api/auth/student/verify-otp',
        { method: 'POST', body: { phone, otp } },
      );
      setToken('student', res.token);
      if (res.student.name) onDone();
      else setStage('name');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong code');
    } finally {
      setBusy(false);
    }
  }

  async function saveName() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/student/me', { method: 'PATCH', role: 'student', body: { name } });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      {stage === 'phone' && (
        <>
          <div>
            <h2 style={{ margin: '0 0 2px' }}>Login with your phone</h2>
            <p className="dim" style={{ margin: 0 }}>One code, no password.</p>
          </div>
          <div>
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
            />
          </div>
          <button disabled={busy || phone.replace(/\D/g, '').length < 10} onClick={requestOtp}>
            {busy ? 'Sending…' : 'Send code'}
          </button>
        </>
      )}

      {stage === 'otp' && (
        <>
          <div>
            <h2 style={{ margin: '0 0 2px' }}>Enter the code</h2>
            <p className="dim" style={{ margin: 0 }}>6-digit code sent to {phone}</p>
          </div>
          <input
            className="big-otp-input"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && otp.length === 6 && void verify()}
            autoFocus
            aria-label="OTP"
          />
          <button disabled={busy || otp.length !== 6} onClick={verify}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button className="ghost" onClick={() => setStage('phone')}>
            Change number
          </button>
        </>
      )}

      {stage === 'name' && (
        <>
          <div>
            <h2 style={{ margin: '0 0 2px' }}>What's your name?</h2>
            <p className="dim" style={{ margin: 0 }}>So the shop knows whose print it is.</p>
          </div>
          <input
            type="text"
            placeholder="Your name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && void saveName()}
            autoFocus
          />
          <button disabled={busy || !name.trim()} onClick={saveName}>
            {busy ? 'Saving…' : 'Continue'}
          </button>
        </>
      )}

      {error && <div className="error">{error}</div>}
    </div>
  );
}
