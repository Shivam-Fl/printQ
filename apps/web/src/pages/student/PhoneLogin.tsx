import { useState } from 'react';
import { api, setToken } from '../../api.js';

/** Inline phone-OTP login used by the student flow. */
export default function PhoneLogin({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [stage, setStage] = useState<'phone' | 'otp'>('phone');
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
      const res = await api<{ token: string }>('/api/auth/student/verify-otp', {
        method: 'POST',
        body: { phone, otp },
      });
      setToken('student', res.token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong code');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div>
        <h2 style={{ margin: '0 0 2px' }}>Login with your phone</h2>
        <p className="dim" style={{ margin: 0 }}>One code, no password.</p>
      </div>
      {stage === 'phone' ? (
        <>
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
      ) : (
        <>
          <div>
            <label htmlFor="otp">6-digit code sent to {phone}</label>
            <input
              id="otp"
              className="big-otp-input"
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && otp.length === 6 && void verify()}
              autoFocus
            />
          </div>
          <button disabled={busy || otp.length !== 6} onClick={verify}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button className="ghost" onClick={() => setStage('phone')}>
            Change number
          </button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
