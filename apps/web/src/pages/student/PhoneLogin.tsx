import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, setToken } from '../../api.js';
import {
  extractOtp,
  formatWait,
  isValidIndianMobile,
  normalizeIndianMobile,
  phoneHint,
  waitSecondsFromError,
} from '../../lib/phone.js';
import { caretAfterDigits, spacedMobile } from './phoneFormat.js';

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

/** Seconds before another code may be requested (matches the API's per-phone resend window). */
const RESEND_SECONDS = 60;
/** A sent code stays usable this long (the API's LOGIN_OTP_TTL_MS). */
const CODE_VALID_MS = 5 * 60_000;

/** A 1-second countdown; set it to N to count down from N. */
function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const timer = setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  return [left, setLeft];
}

/** Passwordless login; first verification doubles as account creation. */
export default function PhoneLogin({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [phoneFinished, setPhoneFinished] = useState(false);
  const [otp, setOtp] = useState('');
  const [name, setName] = useState('');
  const [stage, setStage] = useState<Stage>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState<{ phone: string; at: number } | null>(null);
  const [resendIn, setResendIn] = useCountdown();
  const [verifyWait, setVerifyWait] = useCountdown();
  const phoneInput = useRef<HTMLInputElement>(null);
  /** Digits before the caret at the last edit, so re-spacing the number doesn't throw the caret to the end. */
  const phoneCaretDigits = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = phoneInput.current;
    const digits = phoneCaretDigits.current;
    phoneCaretDigits.current = null;
    if (!input || digits === null || document.activeElement !== input) return;
    const at = caretAfterDigits(input.value, digits);
    input.setSelectionRange(at, at);
  }, [phone]);

  function onPhoneChange(event: ChangeEvent<HTMLInputElement>) {
    const { value, selectionStart } = event.target;
    phoneCaretDigits.current = selectionStart === null ? null : value.slice(0, selectionStart).replace(/\D/g, '').length;
    setPhone(normalizeIndianMobile(value));
  }

  // A "please wait" error is stale once its countdown has run out.
  useEffect(() => {
    if (resendIn === 0 && verifyWait === 0) {
      setError((current) => (/wait|too many|slow down/i.test(current) ? '' : current));
    }
  }, [resendIn, verifyWait]);

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

  const phoneValid = isValidIndianMobile(phone);
  const hint = phoneHint(phone, phoneFinished);
  // Back on the phone step with the same number and a code that still works:
  // reuse it instead of asking for (and waiting on) a new one.
  const codeStillValid = sent !== null && sent.phone === phone && Date.now() - sent.at < CODE_VALID_MS;

  async function requestOtp() {
    setBusy(true);
    setError('');
    try {
      if (firebasePhoneAuthEnabled) {
        const { requestFirebasePhoneOtp } = await loadFirebasePhoneAuth();
        await requestFirebasePhoneOtp(`+91${phone}`);
      }
      else await api('/api/auth/student/request-otp', { method: 'POST', body: { phone } });
      setSent({ phone, at: Date.now() });
      setOtp('');
      setStage('otp');
      setResendIn(RESEND_SECONDS);
    } catch (err) {
      const wait = waitSecondsFromError(err);
      if (wait) setResendIn(wait);
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  }

  function submitPhone(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!phoneValid) {
      setPhoneFinished(true);
      return;
    }
    if (codeStillValid) {
      setError('');
      setStage('otp');
      return;
    }
    if (resendIn > 0) return;
    void requestOtp();
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    if (busy || otp.length !== 6 || verifyWait > 0) return;
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
      const wait = waitSecondsFromError(err);
      if (wait) setVerifyWait(wait);
      setError(err instanceof Error ? err.message : 'Wrong code');
    } finally {
      setBusy(false);
    }
  }

  async function saveName(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim()) return;
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
      <div
        className="auth-progress"
        role="progressbar"
        aria-label="Sign-in progress"
        aria-valuemin={1}
        aria-valuemax={3}
        aria-valuenow={stage === 'phone' ? 1 : stage === 'otp' ? 2 : 3}
        aria-valuetext={`Step ${stage === 'phone' ? 1 : stage === 'otp' ? 2 : 3} of 3`}
      >
        <span className="done" />
        <span className={stage !== 'phone' ? 'done' : ''} />
        <span className={stage === 'name' ? 'done' : ''} />
      </div>

      {stage === 'phone' && (
        <form className="stack" onSubmit={submitPhone} noValidate>
          <div>
            <span className="eyebrow-label">Student account</span>
            <h2>Continue with your phone</h2>
            <p className="dim">New here? We’ll create your account automatically.</p>
            <p className="auth-pay-note">No online payment. You pay the shop by cash or UPI at the counter.</p>
          </div>
          <div className="field">
            <label htmlFor="phone">Mobile number</label>
            <div className="phone-field">
              <span>+91</span>
              <input
                id="phone"
                ref={phoneInput}
                type="tel"
                inputMode="numeric"
                placeholder="98765 43210"
                value={spacedMobile(phone)}
                onChange={onPhoneChange}
                onBlur={() => setPhoneFinished(true)}
                onKeyDown={(event) => { if (event.key === 'Enter') setPhoneFinished(true); }}
                autoComplete="tel"
                enterKeyHint="send"
                aria-invalid={hint ? true : undefined}
                aria-describedby={hint ? 'phone-hint' : undefined}
                autoFocus
              />
            </div>
            {hint && <span id="phone-hint" className="field-help phone-hint" role="status">{hint}</span>}
          </div>
          <button
            type="submit"
            className="full-button"
            disabled={busy || !phoneValid || (resendIn > 0 && !codeStillValid)}
          >
            {busy
              ? 'Sending…'
              : codeStillValid
                ? 'Enter the code we sent'
                : resendIn > 0
                  ? `Send code in ${formatWait(resendIn)}`
                  : 'Send secure code'}
          </button>
          <p className="form-footnote">
            By continuing you agree to the <Link to="/terms">Terms</Link> and{' '}
            <Link to="/privacy">Privacy Policy</Link>, and to receive login and order-status messages from PrintQs.
          </p>
        </form>
      )}

      {stage === 'otp' && (
        <form className="stack" onSubmit={verify} noValidate>
          <div>
            <span className="eyebrow-label">Verify number</span>
            <h2>Enter the six-digit code</h2>
            <p className="dim">Sent to +91 {spacedMobile(phone)}</p>
          </div>
          <input
            className="big-otp-input otp-boxes"
            type="text"
            inputMode="numeric"
            value={otp}
            onChange={(event) => setOtp(extractOtp(event.target.value))}
            autoFocus
            autoComplete="one-time-code"
            enterKeyHint="go"
            aria-label="Six-digit verification code"
          />
          <button type="submit" className="full-button" disabled={busy || otp.length !== 6 || verifyWait > 0}>
            {busy ? 'Checking…' : verifyWait > 0 ? `Try again in ${formatWait(verifyWait)}` : 'Verify and continue'}
          </button>
          <div className="auth-inline-actions">
            <button
              type="button"
              className="text-button"
              onClick={() => {
                // Keep the sent code (and, on Firebase, its confirmation): coming
                // back with the same number goes straight to this step again.
                setError('');
                setStage('phone');
              }}
            >
              Change number
            </button>
            <button type="button" className="text-button" disabled={busy || resendIn > 0} onClick={() => void requestOtp()}>
              {resendIn > 0 ? `Resend in ${formatWait(resendIn)}` : 'Resend code'}
            </button>
          </div>
        </form>
      )}

      {stage === 'name' && (
        <form className="stack" onSubmit={saveName} noValidate>
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
              autoComplete="name"
              autoFocus
            />
          </div>
          <button type="submit" className="full-button" disabled={busy || !name.trim()}>
            {busy ? 'Saving…' : 'Finish setup'}
          </button>
        </form>
      )}

      {error && <div className="error-box" role="alert">{error}</div>}
      {firebasePhoneAuthEnabled && <div id="printq-recaptcha" aria-hidden="true" />}
    </div>
  );
}
