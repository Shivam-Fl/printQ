import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';
import { shouldPollSetup, startSetupPolling } from '../../lib/setupPolling.js';
import ShopLocationEditor from '../../components/ShopLocationEditor.js';
import { buildLocationSave, takeRegisterPin } from '../../lib/locationFlow.js';
import { isListed, setupSteps, statusBanner, visibilityState, type SetupSnapshot } from '../../lib/setupSteps.js';

interface SetupStatus extends SetupSnapshot {
  profileReady: boolean;
  /** False while the owner has paused new orders from the Queue page. */
  acceptingOrders?: boolean;
  counts: SetupSnapshot['counts'] & { printers: number };
  studentUrl: string;
  verification: {
    status: 'draft' | 'submitted' | 'verified' | 'rejected';
    submittedAt: string | null;
    verifiedAt: string | null;
    publishedAt: string | null;
    canSubmit: boolean;
    /** New shops publish themselves once everything is in place; only an explicit false means legacy manual review. */
    autoLive?: boolean;
  };
}

/** Signed-out visits (the desktop tray link) come back here after login. */
const LOGIN_THEN_SETUP = '/dashboard/login?next=/dashboard/setup';
/** Location, prices, counter PC + printer. The "live" card is the result, not a step. */
const STEP_COUNT = 3;

export default function ShopSetup() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [submittingVerification, setSubmittingVerification] = useState(false);
  const [pin, setPin] = useState<{ latitude: number | null; longitude: number | null }>({ latitude: null, longitude: null });
  const [address, setAddress] = useState('');
  const [shopLoaded, setShopLoaded] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [editingLocation, setEditingLocation] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await api<{ setup: SetupStatus }>('/api/shop/setup-status', { role: 'shop' });
      setSetup(result.setup);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate(LOGIN_THEN_SETUP);
      else setError(err instanceof Error ? err.message : 'Could not load setup');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(LOGIN_THEN_SETUP);
      return;
    }
    void refresh();
    api<{ shop: { address: string; latitude: number | null; longitude: number | null } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        // A pin found during register wins over an empty shop, so the owner is not asked for location twice.
        const fromRegister = r.shop.latitude == null || r.shop.longitude == null ? takeRegisterPin() : null;
        // The editor looks a register pin up on mount: it fills an empty address and shows what the map calls the spot.
        setPin(fromRegister ?? { latitude: r.shop.latitude, longitude: r.shop.longitude });
        setAddress(r.shop.address);
      })
      .catch(() => { /* the editor still works without the saved values */ })
      .finally(() => setShopLoaded(true));
  }, [navigate, refresh]);

  // While setup is not ready, keep the status fresh so the shop goes live while this tab is open.
  const waiting = shouldPollSetup(setup);
  useEffect(() => {
    if (!waiting) return;
    return startSetupPolling({
      // Silent: a failed background poll must not replace the page with an error.
      poll: () => {
        api<{ setup: SetupStatus }>('/api/shop/setup-status', { role: 'shop' })
          .then((result) => setSetup(result.setup))
          .catch(() => undefined);
      },
      isHidden: () => document.visibilityState === 'hidden',
      win: window,
      doc: document,
    });
  }, [waiting]);

  useEffect(() => {
    if (!setup?.studentUrl) return;
    QRCode.toDataURL(setup.studentUrl, {
      width: 420,
      margin: 2,
      color: { dark: '#172033', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setQr).catch(() => setQr(''));
  }, [setup?.studentUrl]);

  const steps = useMemo(() => (setup ? setupSteps(setup) : []), [setup]);
  const completeCount = steps.filter((step) => step.key !== 'live' && step.done).length;
  const state = setup ? visibilityState(setup) : null;
  const listed = state ? isListed(state) : false;
  // A live shop with its PC off, a simulator-only live shop, or a shop paused by PrintQs / campus-hidden
  // gets a plain notice instead of onboarding copy (statusBanner is null for a normal live shop).
  const banner = setup && state !== 'not_ready' && state !== 'pending_review' ? statusBanner(setup) : null;
  const pausedByOwner = listed && setup?.acceptingOrders === false;

  async function copyLink() {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.studentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const onPin = useCallback((latitude: number, longitude: number) => setPin({ latitude, longitude }), []);

  async function saveLocation() {
    const body = buildLocationSave(pin, address);
    if (!body) return;
    // Legacy (manually verified) shops are re-reviewed when the pin moves; auto-live shops are not.
    if (setup?.verification.autoLive === false && setup.locationReady && setup.verification.status !== 'draft'
      && !confirm('Changing your counter location sends your shop for re-review and hides it from students until approved. Continue?')) {
      return;
    }
    setSavingLocation(true);
    setLocationError('');
    try {
      await api('/api/shop/me', {
        method: 'PATCH',
        role: 'shop',
        body,
      });
      setEditingLocation(false);
      await refresh();
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Could not save the location. Try again.');
    } finally {
      setSavingLocation(false);
    }
  }

  async function submitVerification() {
    setSubmittingVerification(true);
    setError('');
    try {
      await api('/api/shop/verification/submit', { method: 'POST', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the shop for verification.');
    } finally {
      setSubmittingVerification(false);
    }
  }

  return (
    <main className="page wide shop-page">
      <ShopNav />
      <header className="page-heading setup-heading">
        <div>
          <span className="eyebrow-label">Launch checklist</span>
          <h1>Get your counter ready</h1>
          <p>Three steps to go live. No campus needed.</p>
        </div>
        <div className="setup-score" aria-label={setup ? `${completeCount} of ${STEP_COUNT} setup steps complete` : 'Loading setup'}>
          <strong>{setup ? `${completeCount}/${STEP_COUNT}` : '–'}</strong>
          <span>complete</span>
        </div>
      </header>

      {setup && (
        <div className="progress-track" aria-hidden>
          <span style={{ width: `${(completeCount / STEP_COUNT) * 100}%` }} />
        </div>
      )}

      {state === 'live' && !banner && !pausedByOwner && (
        <div className="notice success-notice">
          <div>
            <strong>You’re live.</strong>
            <p>Students nearby can find your shop now. Keep PrintQs Shop running on the counter PC and share your student link.</p>
          </div>
          <Link className="button-link" to="/dashboard">Open live queue</Link>
        </div>
      )}

      {pausedByOwner && (
        <div className="notice setup-notice" role="status">
          <div>
            <strong>New orders are paused</strong>
            <p>Students see your shop as closed and can’t place new orders. Orders already placed still work.</p>
          </div>
          <Link className="button-link" to="/dashboard">Resume on the Queue page</Link>
        </div>
      )}

      {banner && (
        <div className="notice setup-notice">
          <div>
            <strong>{banner.title}</strong>
            <p>{banner.text}</p>
          </div>
          <Link className="button-link" to={banner.to}>{banner.action}</Link>
        </div>
      )}

      {!setup && !error && (
        <div className="setup-grid" aria-busy="true">
          <p className="dim" role="status" style={{ gridColumn: '1 / -1', margin: 0 }}>Loading your checklist…</p>
          {Array.from({ length: STEP_COUNT + 1 }, (_, index) => (
            <div className="skeleton-card" key={index} style={{ height: 190 }} aria-hidden />
          ))}
        </div>
      )}

      <div className="setup-grid">
        {steps.map((step) => {
          const done = step.done;
          return (
            <section className={`setup-card${done ? ' done' : ''}`} key={step.key}>
              <div className="setup-card-top">
                <span className="step-number">{step.number}</span>
                <span className={`status-dot${done ? ' done' : ''}`}>{done ? 'Complete' : 'To do'}</span>
              </div>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
              {step.note && <p style={{ minHeight: 0 }}>{step.note}</p>}
              {step.key === 'location' && !done && setup && !shopLoaded && (
                <>
                  <div className="skeleton-card" style={{ height: 340 }} aria-hidden />
                  <p role="status" style={{ minHeight: 0, marginTop: 10 }}>Loading the map…</p>
                </>
              )}
              {step.key === 'location' && setup && shopLoaded && (!done || editingLocation) && (
                <>
                  <ShopLocationEditor
                    latitude={pin.latitude}
                    longitude={pin.longitude}
                    address={address}
                    onPin={onPin}
                    onAddress={setAddress}
                    autoDetect={!done}
                  />
                  <button onClick={saveLocation} disabled={savingLocation || pin.latitude == null}>
                    {savingLocation ? 'Saving…' : 'Save location'}
                  </button>
                  {pin.latitude == null && <p className="dim">Use my location, search, or click the map to place the pin. You can always type the address yourself.</p>}
                  {locationError && <div className="error-box" role="alert">{locationError}</div>}
                </>
              )}
              {step.key === 'location' && done && !editingLocation && (
                <button type="button" className="ghost small" onClick={() => setEditingLocation(true)}>Review location →</button>
              )}
              {step.to && <Link to={step.to}>{step.action} →</Link>}
            </section>
          );
        })}
      </div>

      {setup && state === 'not_ready' && setup.verification.autoLive !== false && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Going live</span>
            <h2>Your shop goes live by itself</h2>
            <p>There is nothing to submit and no review to wait for. Once your location is saved, your counter PC is connected and your printer is added, students nearby can find you.</p>
          </div>
        </section>
      )}

      {setup && (state === 'not_ready' || state === 'pending_review') && setup.verification.autoLive === false && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Independent verification</span>
            <h2>{setup.verification.status === 'submitted' ? 'Verification requested' : setup.verification.status === 'verified' ? 'Awaiting publication' : 'Request publication review'}</h2>
            {setup.verification.status === 'submitted' ? (
              <p>Your configuration is in the platform review queue. Students cannot discover this counter until it is verified and published.</p>
            ) : setup.verification.status === 'verified' ? (
              <p>Your counter is verified. A platform administrator still needs to publish it before it is visible to students.</p>
            ) : (
              <p>After the setup steps are complete, submit the counter for a platform review.</p>
            )}
            {setup.verification.canSubmit && (
              <button className="button-link" onClick={submitVerification} disabled={submittingVerification}>
                {submittingVerification ? 'Submitting…' : 'Request verification'}
              </button>
            )}
          </div>
        </section>
      )}

      {setup && listed && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Student ordering link</span>
            <h2>Put this QR at the counter</h2>
            <p>Students upload from anywhere and pay you at the counter. They join the walk-in line only after they arrive.</p>
            <div className="copy-field">
              <code>{setup.studentUrl}</code>
              <button className="secondary small" onClick={copyLink}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <div className="row">
              <a className="button-link secondary" href={setup.studentUrl} target="_blank" rel="noreferrer">Preview student page</a>
              {qr && <a className="text-link" href={qr} download="printq-shop-qr.png">Download QR</a>}
            </div>
          </div>
          <div className="qr-frame">
            {qr ? <img src={qr} alt="QR code for the student ordering page" /> : <div className="skeleton-square" />}
          </div>
        </section>
      )}

      {error && <div className="error-box">{error}</div>}
    </main>
  );
}
