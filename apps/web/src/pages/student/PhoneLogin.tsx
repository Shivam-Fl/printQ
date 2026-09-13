import { useEffect, useState } from 'react';
import { api, setToken } from '../../api.js';

const firebasePhoneAuthEnabled = import.meta.env.VITE_STUDENT_AUTH_PROVIDER === 'firebase'
  && Boolean(
    import.meta.env.VITE_FIREBASE_API_KEY
    && import.meta.env.VITE_FIREBASE_AUTH_DOMAIN
    && import.meta.env.VITE_FIREBASE_PROJECT_ID
    && import.meta.env.VITE_FIREBASE_APP_ID,
  );

let firebasePhoneAuthPromise: Promise<typeof import('../../firebasePhoneAuth.js')> | null = null;

function loadFirebasePhoneAuth() {
  firebasePhoneAuthPromise ??= import('../../firebasePhoneAuth.js');
  return firebasePhoneAuthPromise;
}

type Stage = 'phone' | 'otp' | 'name';

/** Passwordless login; first verification doubles as account creation. */
export default function PhoneLogin({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendIn]);

  useEffect(() => {
    let active = true;
    if (firebasePhoneAuthEnabled) {
      setBusy(true);
      loadFirebasePhoneAuth()
        .then(({ resumeFirebasePhoneSession }) => resumeFirebasePhoneSession())
        .then(async (idToken) => {
          if (!idToken) return;
          const result = await api<{ token: string; student: { name: string | null } }>(
            '/api/auth/student/firebase-login',
            { method: 'POST', body: { idToken } },
          );
          if (!active) return;
          setToken('student', result.token);
          if (result.student.name) onDone();
          else setStage('name');
        })
        .catch(() => {
          // A stale Firebase session is harmless; show the normal phone form.
        })
        .finally(() => { if (active) setBusy(false); });
    }
    return () => {
      active = false;
      void firebasePhoneAuthPromise?.then(({ resetFirebasePhoneAuth }) => resetFirebasePhoneAuth());
    };
    // Run once on entry; onDone is intentionally not a dependency because
    // callers pass an inline navigation callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phoneE164 = `+91${phone.replace(/\D/g, '')}`;

  async function requestOtp() {
    setBusy(true);
    setError('');
    try {
      if (firebasePhoneAuthEnabled) {
        const { requestFirebasePhoneOtp } = await loadFirebasePhoneAuth();
        await requestFirebasePhoneOtp(phoneE164);
      }
      else await api('/api/auth/student/request-otp', { method: 'POST', body: { phone } });
      setStage('otp');
      setResendIn(30);
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
      let result: { token: string; student: { name: string | null } };
      if (firebasePhoneAuthEnabled) {
        const { verifyFirebasePhoneOtp } = await loadFirebasePhoneAuth();
        result = await api('/api/auth/student/firebase-login', {
          method: 'POST',
          body: { idToken: await verifyFirebasePhoneOtp(otp) },
        });
      } else {
        result = await api('/api/auth/student/verify-otp', {
          method: 'POST',
          body: { phone, otp },
        });
      }
      setToken('student', result.token);
      if (result.student.name) onDone();
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
      setError(err instanceof Error ? err.message : 'Could not save your name');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-progress" aria-label="Sign-in progress">
        <span className="done" />
        <span className={stage !== 'phone' ? 'done' : ''} />
        <span className={stage === 'name' ? 'done' : ''} />
      </div>

      {stage === 'phone' && (
        <div className="stack">
          <div>
            <span className="eyebrow-label">Student account</span>
            <h2>Continue with your phone</h2>
            <p className="dim">New here? We’ll create your account automatically.</p>
          </div>
          <div className="field">
            <label htmlFor="phone">Mobile number</label>
            <div className="phone-field">
              <span>+91</span>
              <input
                id="phone"
                type="tel"
                inputMode="numeric"
                placeholder="98765 43210"
                value={phone}
                onChange={(event) => setPhone(event.target.value.replace(/[^\d\s-]/g, '').slice(0, 12))}
                autoComplete="tel"
                autoFocus
              />
            </div>
          </div>
          <button className="full-button" disabled={busy || phone.replace(/\D/g, '').length !== 10} onClick={requestOtp}>
            {busy ? 'Sending…' : 'Send secure code'}
          </button>
          <p className="form-footnote">By continuing, you agree to receive login and order-status messages from PrintQ.</p>
        </div>
      )}

      {stage === 'otp' && (
        <div className="stack">
          <div>
            <span className="eyebrow-label">Verify number</span>
            <h2>Enter the six-digit code</h2>
            <p className="dim">Sent to +91 {phone.replace(/\D/g, '')}</p>
          </div>
          <input
            className="big-otp-input otp-boxes"
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={otp}
            onChange={(event) => setOtp(event.target.value.replace(/\D/g, ''))}
            onKeyDown={(event) => event.key === 'Enter' && otp.length === 6 && void verify()}
            autoFocus
            autoComplete="one-time-code"
            aria-label="Six-digit verification code"
          />
          <button className="full-button" disabled={busy || otp.length !== 6} onClick={verify}>
            {busy ? 'Checking…' : 'Verify and continue'}
          </button>
          <div className="auth-inline-actions">
            <button
              className="text-button"
              onClick={() => {
                if (firebasePhoneAuthEnabled) {
                  void loadFirebasePhoneAuth().then(({ resetFirebasePhoneAuth }) => resetFirebasePhoneAuth());
                }
                setOtp('');
                setStage('phone');
              }}
            >
              Change number
            </button>
            <button className="text-button" disabled={busy || resendIn > 0} onClick={requestOtp}>
              {resendIn > 0 ? `Resend in ${resendIn}s` : 'Resend code'}
            </button>
          </div>
        </div>
      )}

      {stage === 'name' && (
        <div className="stack">
          <div>
            <span className="eyebrow-label">Almost done</span>
            <h2>What should the shop call you?</h2>
            <p className="dim">This appears privately with your orders on the shop dashboard.</p>
          </div>
          <div className="field">
            <label htmlFor="student-name">Full name</label>
            <input
              id="student-name"
              type="text"
              placeholder="Your name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && name.trim() && void saveName()}
              autoComplete="name"
              autoFocus
            />
          </div>
          <button className="full-button" disabled={busy || !name.trim()} onClick={saveName}>
            {busy ? 'Saving…' : 'Finish setup'}
          </button>
        </div>
      )}

      {error && <div className="error-box" role="alert">{error}</div>}
      {firebasePhoneAuthEnabled && <div id="printq-recaptcha" aria-hidden="true" />}
    </div>
  );
}
