import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
// subpath import: keeps zod (the schema bundle) off the sign-in and sign-up pages
import { passwordProblem } from '@printq/shared/password';
import { api, ApiError, fieldErrors, getToken, setShopRole, setToken } from '../../api.js';
import PasswordInput from '../../components/PasswordInput.js';
import ShopSignedIn from '../../components/ShopSignedIn.js';
import Topbar from '../../components/Topbar.js';
import { looksLikePin, maskEmail, PASSWORD_MIN } from '../../lib/authForm.js';
import { extractOtp } from '../../lib/phone.js';
import { postLoginPath } from '../../lib/locationFlow.js';
import { passwordHint, passwordHintClass } from '../../lib/passwordHint.js';
import type { SetupSnapshot } from '../../lib/setupSteps.js';
import { SESSION_ENDED_NOTICE, takeShopSessionNotice, wasRevoked } from '../../lib/shopSessionNotice.js';

type Mode = 'password' | 'pin' | 'forgot-request' | 'forgot-confirm';

function ShopAuthLayout({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="auth-page shop-auth-page">
      <div className="auth-page-main">
        <Topbar tag="shop counter" />
        <div className="auth-copy">
          <span className="eyebrow-label">PrintQs for shops</span>
          <h1>{title}</h1>
          <p>{subtitle}</p>
        </div>
        {children}
      </div>
      <aside className="auth-aside shop-auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">A calmer counter</span>
          <h2>Every order arrives configured and ready for payment or print.</h2>
          <ol>
            <li><span>1</span><div><strong>See who is at your shop</strong><p>Orders placed from home stay out of your line until the student arrives.</p></div></li>
            <li><span>2</span><div><strong>Type one code</strong><p>The order and the amount appear. Take cash or UPI, and it prints.</p></div></li>
            <li><span>3</span><div><strong>Hand it over</strong><p>Pickup, history and receipts in one place.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}

function focusInput(id: string) {
  requestAnimationFrame(() => document.getElementById(id)?.focus());
}

export default function ShopLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  /** "Forgot password?" lives at ?reset=1, so the phone's Back button returns to sign-in instead of leaving. */
  const resetting = params.get('reset') === '1';
  const [mode, setMode] = useState<Mode>(resetting ? 'forgot-request' : 'password');
  const [email, setEmail] = useState(() => {
    const handed = (location.state as { email?: unknown } | null)?.email;
    return typeof handed === 'string' ? handed : '';
  });
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [signedIn, setSignedIn] = useState(() => Boolean(getToken('shop')));
  const handleSignedOut = useCallback(() => setSignedIn(false), []);
  // "Go to dashboard" follows the login rule: a shop that is not live yet goes to Setup.
  const [signedInSetup, setSignedInSetup] = useState<SetupSnapshot | null>(null);
  // Shown once when another device's sign-out or a password reset ended this session.
  const [sessionNotice, setSessionNotice] = useState('');

  useEffect(() => {
    const notice = takeShopSessionNotice();
    if (notice) setSessionNotice(notice);
  }, []);

  useEffect(() => {
    if (!signedIn) return;
    const token = getToken('shop');
    let cancelled = false;
    api<{ setup: SetupSnapshot }>('/api/shop/setup-status', { role: 'shop' })
      .then((r) => { if (!cancelled) setSignedInSetup(r.setup); })
      .catch((err) => {
        if (cancelled || !(err instanceof ApiError) || err.status !== 401) return;
        if (wasRevoked(token)) setSessionNotice(SESSION_ENDED_NOTICE);
        setSignedIn(false);
      });
    return () => { cancelled = true; };
  }, [signedIn]);

  // Back button (or any URL change) away from ?reset=1 returns to the sign-in form.
  const wasResetting = useRef(resetting);
  useEffect(() => {
    if (wasResetting.current && !resetting) {
      setMode('password');
      setError('');
    }
    wasResetting.current = resetting;
  }, [resetting]);

  function switchMode(nextMode: Mode) {
    setError('');
    setMessage('');
    setMode(nextMode);
    const wantsReset = nextMode === 'forgot-request' || nextMode === 'forgot-confirm';
    if (wantsReset === resetting) return;
    setParams((current) => {
      const copy = new URLSearchParams(current);
      if (wantsReset) copy.set('reset', '1');
      else copy.delete('reset');
      return copy;
    }, { replace: !wantsReset, state: location.state });
  }

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
      // A shop that is not live yet lands on its setup checklist instead of an empty queue.
      const setup = await api<{ setup: SetupSnapshot }>('/api/shop/setup-status', { role: 'shop' })
        .then((r) => r.setup)
        .catch(() => null);
      navigate(postLoginPath(params.get('next'), setup), { replace: true });
    } catch (err) {
      setError(loginErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function loginErrorMessage(err: unknown): string {
    if (err instanceof ApiError && err.status === 400) {
      const fields = fieldErrors(err);
      if (fields.email) return 'Enter a valid email address.';
      if (mode === 'pin') return 'Your PIN is 4 to 6 digits.';
      return 'Wrong email or password.';
    }
    return err instanceof Error ? err.message : 'Could not sign in. Please try again.';
  }

  /** One submit path for Enter and the button: never send an empty email; move to the missing field instead. */
  function submitLogin(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!email.trim()) {
      setError('Enter your email.');
      focusInput('email');
      return;
    }
    if (mode === 'pin') {
      if (pin.length < 4) {
        setError(pin ? 'Your PIN is 4 to 6 digits.' : '');
        focusInput('pin');
        return;
      }
      void login('/api/auth/shop/staff-login', { email: email.trim(), pin });
      return;
    }
    if (!password) {
      setError('');
      focusInput('password');
      return;
    }
    if (looksLikePin(password)) {
      setError('That looks like a staff PIN. Tap “Staff? Use your PIN” below and enter it there.');
      return;
    }
    if (password.length < PASSWORD_MIN) {
      setError('Wrong email or password. Passwords are at least 8 characters.');
      return;
    }
    void login('/api/auth/shop/login', { email: email.trim(), password });
  }

  async function requestReset(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!email.trim()) {
      setError('Enter the email you sign in with.');
      focusInput('remail');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/shop/request-reset', { method: 'POST', body: { email: email.trim() } });
      setMessage('');
      setMode('forgot-confirm');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the reset code. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmReset(event: FormEvent) {
    event.preventDefault();
    if (busy || otp.length !== 6) return;
    if (passwordProblem(newPassword, 'New password')) {
      // the red line under the box already says what is wrong
      focusInput('rnew');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/shop/reset-password', {
        method: 'POST',
        body: { email: email.trim(), otp, newPassword },
      });
      setPassword('');
      setOtp('');
      setNewPassword('');
      switchMode('password');
      setMessage('Password updated — sign in below.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reset your password. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (signedIn) {
    return (
      <ShopAuthLayout title="You’re already signed in." subtitle="This device is signed in to a shop dashboard.">
        <ShopSignedIn to={postLoginPath(params.get('next'), signedInSetup)} hint="To use a different account, sign out first." onSignedOut={handleSignedOut} />
      </ShopAuthLayout>
    );
  }

  if (mode === 'forgot-request') {
    return (
      <ShopAuthLayout title="Reset your password" subtitle="We’ll send a six-digit code to the email you sign in with.">
        <form className="auth-card stack" onSubmit={requestReset} noValidate>
          <div>
            <label htmlFor="remail">Your sign-in email</label>
            <input id="remail" type="email" inputMode="email" value={email} onChange={(e) => { setEmail(e.target.value); setError(''); }} autoComplete="email" autoFocus />
          </div>
          {/* above the button, so a phone keyboard never hides it */}
          {error && <div className="error-box" role="alert">{error}</div>}
          <button type="submit" className="full-button" disabled={busy}>
            {busy ? 'Sending…' : 'Send reset code'}
          </button>
          <button type="button" className="text-button" onClick={() => switchMode('password')}>← Back to sign in</button>
        </form>
      </ShopAuthLayout>
    );
  }

  if (mode === 'forgot-confirm') {
    const newHint = passwordHint(newPassword, 'New password');
    return (
      <ShopAuthLayout title="Choose a new password" subtitle="Enter the code from your email, then create a password you don’t use elsewhere.">
        <form className="auth-card stack" onSubmit={confirmReset} noValidate>
          <div className="notice success-notice" role="status">
            <span>
              If <b>{maskEmail(email)}</b> has a PrintQs account, we’ve emailed it a 6-digit code.
              The code works for 15 minutes. Can’t see it? Check your spam folder.
            </span>
          </div>
          <div>
            <label htmlFor="rotp">6-digit code</label>
            <input
              id="rotp"
              type="text"
              inputMode="numeric"
              value={otp}
              onChange={(e) => setOtp(extractOtp(e.target.value))}
              autoComplete="one-time-code"
              className="otp-boxes"
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="rnew">New password</label>
            <PasswordInput
              id="rnew"
              value={newPassword}
              onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
              autoComplete="new-password"
              aria-describedby="rnew-help"
              aria-invalid={newHint.state === 'weak' ? true : undefined}
            />
            {/* same rule as the API: a password it will refuse never gets a green tick */}
            <span id="rnew-help" className={passwordHintClass(newHint)} aria-live="polite">{newHint.text}</span>
          </div>
          {/* above the button, so it is not pushed off the bottom of a phone screen */}
          {error && <div className="error-box" role="alert">{error}</div>}
          <button type="submit" className="full-button" disabled={busy || otp.length !== 6 || newHint.state !== 'ok'}>
            {busy ? 'Saving…' : 'Reset password'}
          </button>
          <div className="auth-inline-actions">
            <button type="button" className="text-button" onClick={() => switchMode('password')}>← Back to sign in</button>
            <button type="button" className="text-button" onClick={() => { setError(''); setOtp(''); setMode('forgot-request'); }}>Send a new code</button>
          </div>
        </form>
      </ShopAuthLayout>
    );
  }

  return (
    <ShopAuthLayout title="Run your print queue." subtitle="Sign in to release jobs, watch every printer and keep the counter moving.">
      <form className="auth-card stack" onSubmit={submitLogin} noValidate>
        {message && <div className="notice success-notice" role="status"><span>{message}</span></div>}
        {sessionNotice && !message && <div className="notice setup-notice" role="status"><span>{sessionNotice}</span></div>}
        <div>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus={!email} />
        </div>
        {mode === 'pin' ? (
          <div>
            <label htmlFor="pin">PIN</label>
            <input
              id="pin"
              name="pin"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              autoComplete="current-password"
              autoFocus={Boolean(email)}
              aria-describedby="pin-help"
            />
            <span id="pin-help" className="field-help">Staff: ask the owner for your 4-6 digit PIN.</span>
          </div>
        ) : (
          <div>
            <label htmlFor="password">Password</label>
            <PasswordInput
              id="password"
              name="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus={Boolean(email)}
            />
          </div>
        )}
        <button type="submit" className="full-button" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="auth-inline-actions">
          <button type="button" className="text-button" onClick={() => switchMode(mode === 'pin' ? 'password' : 'pin')}>
            {mode === 'pin' ? 'Use password instead' : 'Staff? Use your PIN'}
          </button>
          {mode === 'password' && (
            <button type="button" className="text-button" onClick={() => switchMode('forgot-request')}>Forgot password?</button>
          )}
        </div>
      </form>
      <p className="dim auth-after-card">
        New shop? <Link to="/dashboard/register">Register your shop (about three minutes)</Link>
      </p>
    </ShopAuthLayout>
  );
}
