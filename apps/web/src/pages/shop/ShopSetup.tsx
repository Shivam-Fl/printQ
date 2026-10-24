import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';
import ShopLocationEditor from '../../components/ShopLocationEditor.js';

interface SetupStatus {
  profileReady: boolean;
  locationReady: boolean;
  pricingReady: boolean;
  printerReady: boolean;
  agentReady: boolean;
  ready: boolean;
  counts: {
    printers: number;
    linkedPrinters: number;
    onlinePrinters: number;
    agents: number;
    onlineAgents: number;
  };
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

type StepKey = 'locationReady' | 'pricingReady' | 'agentReady' | 'ready';

const STEPS: Array<{ key: StepKey; number: string; title: string; body: string; to?: string; action?: string }> = [
  {
    key: 'locationReady',
    number: '01',
    title: 'Confirm your location',
    body: 'We try to find you automatically. Check the pin and address, then save.',
  },
  {
    key: 'pricingReady',
    number: '02',
    title: 'Check your prices',
    body: 'Sensible defaults are already filled in. Keep them or change paper, colour and binding prices.',
    to: '/dashboard/settings',
    action: 'Review prices',
  },
  {
    key: 'agentReady',
    number: '03',
    title: 'Connect your shop PC',
    body: 'Install the PrintQ app on the computer next to your printer. It finds your printers by itself.',
    to: '/dashboard/agents',
    action: 'Connect computer',
  },
  {
    key: 'ready',
    number: '04',
    title: 'You are live',
    body: 'As soon as your PC is connected, students nearby can find your shop and send jobs.',
  },
];

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
      if ((err as { status?: number }).status === 401) navigate('/dashboard/login');
      else setError(err instanceof Error ? err.message : 'Could not load setup');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    void refresh();
    api<{ shop: { address: string; latitude: number | null; longitude: number | null } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        setPin({ latitude: r.shop.latitude, longitude: r.shop.longitude });
        setAddress(r.shop.address);
      })
      .catch(() => { /* the editor still works without the saved values */ })
      .finally(() => setShopLoaded(true));
  }, [navigate, refresh]);

  useEffect(() => {
    if (!setup?.studentUrl) return;
    QRCode.toDataURL(setup.studentUrl, {
      width: 420,
      margin: 2,
      color: { dark: '#172033', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    }).then(setQr).catch(() => setQr(''));
  }, [setup?.studentUrl]);

  const completeCount = useMemo(
    () => (setup ? STEPS.filter((step) => setup[step.key]).length : 0),
    [setup],
  );

  async function copyLink() {
    if (!setup) return;
    await navigator.clipboard.writeText(setup.studentUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  const onPin = useCallback((latitude: number, longitude: number) => setPin({ latitude, longitude }), []);

  async function saveLocation() {
    if (pin.latitude == null || pin.longitude == null) return;
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
        body: { latitude: pin.latitude, longitude: pin.longitude, address: address.trim() || 'Pinned location' },
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
    <div className="page wide shop-page">
      <ShopNav />
      <header className="page-heading setup-heading">
        <div>
          <span className="eyebrow-label">Launch checklist</span>
          <h1>Get your counter ready</h1>
          <p>Four short steps, about three minutes. No campus needed.</p>
        </div>
        <div className="setup-score" aria-label={`${completeCount} of ${STEPS.length} setup steps complete`}>
          <strong>{completeCount}/{STEPS.length}</strong>
          <span>complete</span>
        </div>
      </header>

      {setup && (
        <div className="progress-track" aria-hidden>
          <span style={{ width: `${(completeCount / STEPS.length) * 100}%` }} />
        </div>
      )}

      {setup?.ready && (
        <div className="notice success-notice">
          <div>
            <strong>Your shop is live.</strong>
            <p>Students nearby can find it now. Keep PrintQ running on the counter PC and share your student link.</p>
          </div>
          <Link className="button-link" to="/dashboard">Open live queue</Link>
        </div>
      )}

      <div className="setup-grid">
        {STEPS.map((step) => {
          const done = Boolean(setup?.[step.key]);
          return (
            <section className={`setup-card${done ? ' done' : ''}`} key={step.key}>
              <div className="setup-card-top">
                <span className="step-number">{step.number}</span>
                <span className={`status-dot${done ? ' done' : ''}`}>{done ? 'Complete' : 'To do'}</span>
              </div>
              <h2>{step.title}</h2>
              <p>{step.body}</p>
              {step.key === 'locationReady' && setup && shopLoaded && (!done || editingLocation) && (
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
              {step.key === 'locationReady' && done && !editingLocation && (
                <button type="button" className="ghost small" onClick={() => setEditingLocation(true)}>Review location →</button>
              )}
              {step.to && <Link to={step.to}>{done ? 'Review' : step.action} →</Link>}
            </section>
          );
        })}
      </div>

      {setup && !setup.ready && setup.verification.autoLive !== false && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Going live</span>
            <h2>Your shop goes live by itself</h2>
            <p>There is nothing to submit and no review to wait for. Once your location is saved, prices are set and your PC is connected to a printer, students nearby can find you.</p>
          </div>
        </section>
      )}

      {setup && !setup.ready && setup.verification.autoLive === false && (
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

      {setup?.ready && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Student ordering link</span>
            <h2>Put this QR at the counter</h2>
            <p>Students upload and pay from anywhere, then join the walk-in line only after they physically arrive.</p>
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

      <section className="simulator-note">
        <div>
          <span className="eyebrow-label">No printer nearby?</span>
          <h2>Test the entire flow in simulation mode</h2>
          <p>The simulated agent still claims jobs, downloads the real PDF and reports print completion. No paper or hardware is used.</p>
        </div>
        <Link className="button-link secondary" to="/dashboard/agents">Set up a simulator</Link>
      </section>

      {error && <div className="error-box">{error}</div>}
    </div>
  );
}
