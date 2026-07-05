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
      setError(err instanceof Error ? err.message : 'Failed');
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
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Login with your phone</h2>
      {stage === 'phone' ? (
        <>
          <div>
            <label>Mobile number</label>
            <input
              type="tel"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoFocus
            />
          </div>
          <button disabled={busy || phone.replace(/\D/g, '').length < 10} onClick={requestOtp}>
            {busy ? 'Sending…' : 'Send OTP'}
          </button>
        </>
      ) : (
        <>
          <div>
            <label>6-digit code sent to {phone}</label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              autoFocus
            />
          </div>
          <button disabled={busy || otp.length !== 6} onClick={verify}>
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button className="ghost" onClick={() => setStage('phone')}>Change number</button>
        </>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
