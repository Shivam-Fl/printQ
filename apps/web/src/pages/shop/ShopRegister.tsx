import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, fieldErrors, getToken, setShopRole, setToken } from '../../api.js';
import PasswordInput from '../../components/PasswordInput.js';
import ShopSignedIn from '../../components/ShopSignedIn.js';
import Topbar from '../../components/Topbar.js';
import {
  firstInvalid,
  isDuplicateEmailError,
  REGISTER_FIELDS,
  validateShopRegister,
  type RegisterField,
  type RegisterForm,
} from '../../lib/authForm.js';
import { addressIsReplaceable, reverseLabel } from '../../lib/geocode.js';
import {
  addressAfterReverse, locationFailureLead, postLoginPath, registerFillNote, registerPinFromFix, stashRegisterPin,
} from '../../lib/locationFlow.js';
import { passwordHint, passwordHintClass } from '../../lib/passwordHint.js';
import type { SetupSnapshot } from '../../lib/setupSteps.js';

const INPUT_IDS: Record<RegisterField, string> = {
  shopName: 'shopName',
  address: 'address',
  ownerName: 'ownerName',
  email: 'remail',
  password: 'rpass',
};

/** Bring a field (and the message under it) into view, then put the cursor in it. */
function focusField(field: RegisterField) {
  const input = document.getElementById(INPUT_IDS[field]);
  if (!input) return;
  input.scrollIntoView({ block: 'center' });
  input.focus({ preventScroll: true });
}

export default function ShopRegister() {
  const navigate = useNavigate();
  const [form, setForm] = useState<RegisterForm>({
    shopName: '',
    address: '',
    ownerName: '',
    email: '',
    password: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [errors, setErrors] = useState<Partial<Record<RegisterField, string>>>({});
  const [duplicateEmail, setDuplicateEmail] = useState('');
  const [signedIn, setSignedIn] = useState(() => Boolean(getToken('shop')));
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState('');
  const errorBox = useRef<HTMLDivElement>(null);
  /** A precise (<= 100 m) fix from "Fill from my location", handed to the pin step so it does not ask again. */
  const coords = useRef<{ latitude: number; longitude: number } | null>(null);
  /** The address this button last filled in, so a second tap may refresh it but typed text is never replaced. */
  const lastFilled = useRef<string | null>(null);
  const addressRef = useRef(form.address);
  addressRef.current = form.address;
  const handleSignedOut = useCallback(() => setSignedIn(false), []);
  // "Go to dashboard" follows the login rule: a shop that is not live yet goes to Setup (PSLS-6).
  const [signedInSetup, setSignedInSetup] = useState<SetupSnapshot | null>(null);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    api<{ setup: SetupSnapshot }>('/api/shop/setup-status', { role: 'shop' })
      .then((r) => { if (!cancelled) setSignedInSetup(r.setup); })
      .catch((err) => {
        // 401: the stale token was cleared, so show the form. Anything else: keep the default /dashboard link.
        if (!cancelled && err instanceof ApiError && err.status === 401) setSignedIn(false);
      });
    return () => { cancelled = true; };
  }, [signedIn]);

  // A general error (network, rate limit) sits under the button: make sure it is on screen.
  useEffect(() => {
    if (error) errorBox.current?.scrollIntoView({ block: 'nearest' });
  }, [error]);

  const set = (key: RegisterField) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setForm((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
    if (key === 'email') setDuplicateEmail('');
  };

  /** Optional convenience: fill the address from this device's location (asks permission on click only). */
  function fillAddressFromDevice() {
    if (!navigator.geolocation) {
      setLocateNote('This device cannot share its location. Type the address instead.');
      return;
    }
    setLocating(true);
    setLocateNote('');
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const { accuracy } = position.coords;
        // A rough fix (> 100 m) is not handed on: setup finds the location again and the owner taps the entrance.
        coords.current = registerPinFromFix(position.coords);
        // Never replace an address the owner typed (e.g. "Shop 7, Janpath Market"), and skip the lookup then.
        if (!addressIsReplaceable(addressRef.current, lastFilled.current)) {
          setLocateNote(registerFillNote('kept', accuracy));
          setLocating(false);
          return;
        }
        const label = await reverseLabel(Number(position.coords.latitude.toFixed(6)), Number(position.coords.longitude.toFixed(6)));
        // Re-check after the lookup: the owner may have typed meanwhile.
        const next = addressAfterReverse(addressRef.current, label, lastFilled.current);
        if (!label) setLocateNote(registerFillNote('not_found', accuracy));
        else if (next === label) {
          lastFilled.current = label;
          setForm((current) => ({ ...current, address: label }));
          setErrors((current) => ({ ...current, address: undefined }));
          setLocateNote(registerFillNote('filled', accuracy));
        } else setLocateNote(registerFillNote('kept', accuracy));
        setLocating(false);
      },
      (reason) => {
        const lead = locationFailureLead(reason.code === reason.PERMISSION_DENIED);
        setLocateNote(`${lead}. Type the address instead; you will pin the exact spot next.`);
        setLocating(false);
      },
      { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
    );
  }

  function showFieldErrors(next: Partial<Record<RegisterField, string>>): boolean {
    const first = firstInvalid(REGISTER_FIELDS, next);
    setErrors(next);
    if (!first) return false;
    // Wait for the messages to render so the scroll includes them.
    requestAnimationFrame(() => focusField(first));
    return true;
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    setDuplicateEmail('');
    if (showFieldErrors(validateShopRegister(form))) return;
    setBusy(true);
    try {
      const res = await api<{ token: string; shop: { slug: string } }>('/api/auth/shop/register', {
        method: 'POST',
        body: form,
      });
      setToken('shop', res.token);
      setShopRole('owner');
      if (coords.current) stashRegisterPin(coords.current.latitude, coords.current.longitude);
      navigate('/dashboard/setup', { replace: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create your shop. Please try again.';
      const fromApi = fieldErrors(err);
      const known: Partial<Record<RegisterField, string>> = {};
      const other: string[] = [];
      for (const [field, text] of Object.entries(fromApi)) {
        if ((REGISTER_FIELDS as string[]).includes(field)) known[field as RegisterField] = text;
        else other.push(text);
      }
      if (isDuplicateEmailError(message)) {
        known.email = 'This email already has a PrintQs shop.';
        setDuplicateEmail(form.email.trim());
      }
      const hasFieldErrors = showFieldErrors(known);
      if (other.length) setError(other.join(' '));
      else if (!hasFieldErrors) setError(message);
    } finally {
      setBusy(false);
    }
  }

  /** aria-describedby for a field: its helper text (if any) and its error (if any). */
  const describedBy = (field: RegisterField, helpId?: string) =>
    [helpId, errors[field] ? `${INPUT_IDS[field]}-error` : ''].filter(Boolean).join(' ') || undefined;

  const fieldError = (field: RegisterField) =>
    errors[field] ? (
      <span id={`${INPUT_IDS[field]}-error`} className="field-error">
        {errors[field]}
        {field === 'email' && duplicateEmail && (
          <>
            {' '}
            <Link to="/dashboard/login" state={{ email: duplicateEmail }}>Sign in</Link>
            {' or '}
            <Link to="/dashboard/login?reset=1" state={{ email: duplicateEmail }}>Forgot password?</Link>
          </>
        )}
      </span>
    ) : null;

  // Same rule as the API, so a password that will be rejected never shows a green tick.
  const hint = passwordHint(form.password);

  return (
    <main className="auth-page shop-auth-page register-page">
      <div className="auth-page-main">
        <Topbar tag="shop counter" />
        <div className="auth-copy">
          <span className="eyebrow-label">Get your counter online</span>
          <h1>Set up your shop.</h1>
          {!signedIn && <p>Five fields and about three minutes. Any shop can join, on a campus or not.</p>}
        </div>
        {signedIn ? (
          <ShopSignedIn
            to={postLoginPath(null, signedInSetup)}
            hint="To register another shop, sign out first."
            onSignedOut={handleSignedOut}
          />
        ) : (
          <form className="auth-card register-card stack" onSubmit={register} noValidate>
            <div className="auth-form-grid">
              <div className="field grow">
                <label htmlFor="shopName">Shop name</label>
                <input id="shopName" type="text" placeholder="Sharma Xerox & Prints" value={form.shopName} onChange={set('shopName')} autoComplete="organization" autoFocus
                  aria-invalid={errors.shopName ? true : undefined} aria-describedby={describedBy('shopName')} />
                {fieldError('shopName')}
              </div>
              <div className="field full-field">
                <label htmlFor="address">Shop address</label>
                <input id="address" type="text" placeholder="12 Market Road, near the bus stand" value={form.address} onChange={set('address')} autoComplete="street-address"
                  aria-invalid={errors.address ? true : undefined} aria-describedby={describedBy('address')} />
                {fieldError('address')}
                <span className="field-help">
                  <button type="button" className="ghost small" onClick={fillAddressFromDevice} disabled={locating}>
                    {locating ? 'Finding your address…' : 'Fill from my location'}
                  </button>
                  {locateNote && <span role="status"> {locateNote}</span>}
                </span>
              </div>
              <div className="field grow">
                <label htmlFor="ownerName">Owner name</label>
                <input id="ownerName" type="text" placeholder="Your full name" value={form.ownerName} onChange={set('ownerName')} autoComplete="name"
                  aria-invalid={errors.ownerName ? true : undefined} aria-describedby={describedBy('ownerName')} />
                {fieldError('ownerName')}
              </div>
              <div className="field grow">
                <label htmlFor="remail">Email</label>
                <input id="remail" type="email" inputMode="email" placeholder="owner@shop.com" value={form.email} onChange={set('email')} autoComplete="email"
                  aria-invalid={errors.email ? true : undefined} aria-describedby={describedBy('email')} />
                {fieldError('email')}
              </div>
              <div className="field full-field">
                <label htmlFor="rpass">Password</label>
                <PasswordInput id="rpass" placeholder="At least 8 characters" value={form.password} onChange={set('password')} autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined} aria-describedby={describedBy('password', 'rpass-help')} />
                <span id="rpass-help" className={passwordHintClass(hint)}>
                  {hint.text}
                </span>
                {fieldError('password')}
              </div>
            </div>
            <button type="submit" className="full-button" disabled={busy}>
              {busy ? 'Creating your shop…' : 'Create shop & continue'}
            </button>
            {error && <div ref={errorBox} className="error-box" role="alert">{error}</div>}
            <p className="form-footnote">
              By creating an account you agree to the{' '}
              <Link to="/terms" target="_blank" rel="noreferrer">Terms</Link> and{' '}
              <Link to="/privacy" target="_blank" rel="noreferrer">Privacy Policy</Link>, and confirm you’re authorised to manage this shop’s pricing and printers.
            </p>
          </form>
        )}
        {!signedIn && <p className="dim auth-after-card">Already registered? <Link to="/dashboard/login">Sign in</Link></p>}
        {/* phones hide the side panel: say what comes next right under the form */}
        {!signedIn && (
          <p className="register-next phone-only">Next: put your shop on the map, check prices, then connect the computer next to your printer. Your shop goes live by itself.</p>
        )}
      </div>
      <aside className="auth-aside shop-auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">Launch checklist</span>
          <h2>Three steps to go live.</h2>
          <ol>
            <li><span>1</span><div><strong>Confirm your location</strong><p>We find your area; you tap your shop entrance on the map.</p></div></li>
            <li><span>2</span><div><strong>Check your prices</strong><p>Sensible defaults are already filled in.</p></div></li>
            <li><span>3</span><div><strong>Connect the counter PC and add your printer</strong><p>Install the PrintQs Shop app on the counter PC, sign in and add your printer. Students nearby can find you once your printer is added.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
