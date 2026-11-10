import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';
import ShopTabs from '../../components/ShopTabs.js';
import { PcLinkShare, PcSteps } from '../../components/PcSetup.js';
import { shouldPollSetup, startSetupPolling } from '../../lib/setupPolling.js';
import ShopLocationEditor from '../../components/ShopLocationEditor.js';
import { buildLocationSave, takeRegisterPin } from '../../lib/locationFlow.js';
import { WINDOWS_DOWNLOAD_URL, detectPhoneLike } from '../../lib/pcDownload.js';
import { isListed, isSimulatorPrinterName, platformFeeLine, setupSteps, statusBanner, visibilityState, type SetupSnapshot } from '../../lib/setupSteps.js';
import { shopStatus } from '../../lib/shopStatus.js';
import DetectedPrinters from './DetectedPrinters.js';
import { practiceOnly, unlinkedDetectedPrinters, type DetectedPrinterLite } from './printersView.js';

interface SetupStatus extends SetupSnapshot {
  profileReady: boolean;
  /** False while the owner has paused new orders from the counter. */
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

interface AgentLite {
  status: 'online' | 'offline';
  detectedPrinters: DetectedPrinterLite[] | null;
}
interface PrinterLite {
  osPrinterName: string | null;
  status: string;
}

/** Signed-out visits (the desktop tray link) come back here after login. */
const LOGIN_THEN_SETUP = '/dashboard/login?next=/dashboard/setup';
const STEP_COUNT = 3;

export default function ShopSetup() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [printers, setPrinters] = useState<PrinterLite[]>([]);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [submittingVerification, setSubmittingVerification] = useState(false);
  const [pin, setPin] = useState<{ latitude: number | null; longitude: number | null }>({ latitude: null, longitude: null });
  const [address, setAddress] = useState('');
  const [savedAddress, setSavedAddress] = useState('');
  const [shopLoaded, setShopLoaded] = useState(false);
  const [savingLocation, setSavingLocation] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [editingLocation, setEditingLocation] = useState(false);
  const [phone] = useState(detectPhoneLike);
  const desktopApp = Boolean(window.printqsDesktop);
  const liveBanner = useRef<HTMLDivElement>(null);

  const loadHardware = useCallback(async () => {
    const [a, p] = await Promise.all([
      api<{ agents: AgentLite[] }>('/api/shop/agents', { role: 'shop' }),
      api<{ printers: PrinterLite[] }>('/api/shop/printers', { role: 'shop' }),
    ]);
    setAgents(a.agents);
    setPrinters(p.printers);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [result] = await Promise.all([
        api<{ setup: SetupStatus }>('/api/shop/setup-status', { role: 'shop' }),
        loadHardware(),
      ]);
      setSetup(result.setup);
      shopStatus.set(result.setup);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate(LOGIN_THEN_SETUP);
      else setError(err instanceof Error ? err.message : 'Could not load setup');
    }
  }, [navigate, loadHardware]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(LOGIN_THEN_SETUP);
      return;
    }
    void refresh();
    // A stale answer (React runs this twice in development) must never wipe a pin that was placed meanwhile.
    let cancelled = false;
    api<{ shop: { address: string; latitude: number | null; longitude: number | null } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        if (cancelled) return;
        // A pin found during register wins over an empty shop, so the owner is not asked for location twice.
        const fromRegister = r.shop.latitude == null || r.shop.longitude == null ? takeRegisterPin() : null;
        // The editor looks a register pin up on mount: it fills an empty address and shows what the map calls the spot.
        setPin((prev) => (prev.latitude != null ? prev : fromRegister ?? { latitude: r.shop.latitude, longitude: r.shop.longitude }));
        setAddress((prev) => prev || r.shop.address);
        setSavedAddress(r.shop.address);
      })
      .catch(() => { /* the editor still works without the saved values */ })
      .finally(() => { if (!cancelled) setShopLoaded(true); });
    return () => { cancelled = true; };
  }, [navigate, refresh]);

  // While setup is not ready, keep the status fresh so the shop goes live while this tab is open.
  const waiting = shouldPollSetup(setup);
  useEffect(() => {
    if (!waiting) return;
    return startSetupPolling({
      // Silent: a failed background poll must not replace the page with an error.
      poll: () => {
        Promise.all([api<{ setup: SetupStatus }>('/api/shop/setup-status', { role: 'shop' }), loadHardware()])
          .then(([result]) => { setSetup(result.setup); shopStatus.set(result.setup); })
          .catch(() => undefined);
      },
      isHidden: () => document.visibilityState === 'hidden',
      win: window,
      doc: document,
    });
  }, [waiting, loadHardware]);

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
  // practice mode is never 'live' for students (production never lists a simulator-only shop)
  const listed = state ? isListed(state) : false;
  const banner = setup && state !== 'not_ready' && state !== 'pending_review' ? statusBanner(setup) : null;
  const pausedByOwner = listed && setup?.acceptingOrders === false;
  const detected = unlinkedDetectedPrinters(agents, printers);
  const onlineAgents = agents.filter((a) => a.status === 'online').length;
  const practice = practiceOnly(printers, isSimulatorPrinterName);
  const live = listed && !practice;
  const currentKey = steps.find((s) => s.key !== 'live' && !s.done)?.key ?? null;

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
      await api('/api/shop/me', { method: 'PATCH', role: 'shop', body });
      setEditingLocation(false);
      setSavedAddress(address);
      await refresh();
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Could not save the location. Try again.');
    } finally {
      setSavingLocation(false);
    }
  }

  async function printerAdded() {
    await refresh();
    // the result (live, or what is still missing) shows at the top: bring it into view
    requestAnimationFrame(() => liveBanner.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
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

  const stepClass = (done: boolean, key: string) => `setup-step${done ? ' done' : key === currentKey ? ' current' : ''}`;
  const stepMark = (done: boolean, n: number) => <span className="setup-step-mark" aria-hidden>{done ? '✓' : n}</span>;
  const status = (done: boolean) => <span className={`badge ${done ? 'ok' : 'warn'}`}>{done ? 'Done' : 'To do'}</span>;
  const locationStep = steps.find((s) => s.key === 'location');
  const pricesStep = steps.find((s) => s.key === 'prices');
  const pcStep = steps.find((s) => s.key === 'pc');
  const pcDone = Boolean(pcStep?.done) && !practice;

  return (
    <main className="page wide shop-page setup-page">
      <ShopNav />
      <ShopTabs />

      <header className="setup-head">
        <h1>{live ? 'Your shop is live' : 'Get your shop live'}</h1>
        <p>{live ? 'Everything below is done. Change any of it whenever you need.' : 'Three steps. Your shop goes live by itself as soon as they are done.'}</p>
        {setup && (
          <div className="setup-progress" aria-label={`${completeCount} of ${STEP_COUNT} steps done`}>
            <span>{completeCount} of {STEP_COUNT} done</span>
            <div className="progress-track" aria-hidden><span style={{ width: `${(completeCount / STEP_COUNT) * 100}%` }} /></div>
          </div>
        )}
      </header>

      <div ref={liveBanner} className="setup-banners">
        {state === 'live' && !banner && !pausedByOwner && !practice && (
          <div className="notice ok" role="status">
            <div>
              <strong>You’re live</strong>
              <p>Students nearby can find your shop and order now. Keep PrintQs Shop running on the counter PC.</p>
            </div>
            <Link className="button-link" to="/dashboard">Open the counter</Link>
          </div>
        )}
        {pausedByOwner && (
          <div className="notice warn" role="status">
            <div>
              <strong>New orders are paused</strong>
              <p>Students see your shop as closed. Orders already placed still work.</p>
            </div>
            <Link className="button-link" to="/dashboard">Resume on the counter</Link>
          </div>
        )}
        {banner && (
          <div className={`notice ${state === 'hidden_by_admin' || state === 'campus_inactive' || state === 'live_pc_offline' ? 'danger' : 'warn'}`}>
            <div>
              <strong>{banner.title}</strong>
              <p>{banner.text}</p>
            </div>
            <Link className="button-link secondary" to={banner.to}>{banner.action}</Link>
          </div>
        )}
      </div>

      {!setup && !error && (
        <div className="skeleton-list" role="status" aria-label="Loading your checklist">
          <div className="skeleton-card" style={{ height: 120 }} />
          <div className="skeleton-card" style={{ height: 80 }} />
          <div className="skeleton-card" style={{ height: 80 }} />
        </div>
      )}

      {setup && locationStep && pricesStep && pcStep && (
        <ol className="setup-steps">
          <li className={stepClass(locationStep.done, 'location')}>
            <div className="setup-step-head">
              {stepMark(locationStep.done, 1)}
              <h2>Shop location</h2>
              {status(locationStep.done)}
            </div>
            <div className="setup-step-body">
              {locationStep.done && !editingLocation ? (
                <div className="setup-step-summary">
                  <p>Saved: <strong>{savedAddress || 'your shop entrance'}</strong>. Students join your line only when they are near this pin.</p>
                  <button type="button" className="quiet" onClick={() => setEditingLocation(true)}>Change location</button>
                </div>
              ) : !shopLoaded ? (
                <div className="skeleton-card" style={{ height: 300 }} aria-hidden />
              ) : (
                <>
                  <p className="setup-step-lead">Put the pin on your shop entrance. Students can join your line only when they are near it.</p>
                  <ShopLocationEditor
                    latitude={pin.latitude}
                    longitude={pin.longitude}
                    address={address}
                    onPin={onPin}
                    onAddress={setAddress}
                    autoDetect={!locationStep.done}
                  />
                  <div className="row">
                    <button type="button" onClick={() => void saveLocation()} disabled={savingLocation || pin.latitude == null}>
                      {savingLocation ? 'Saving…' : 'Save location'}
                    </button>
                    {locationStep.done && <button type="button" className="quiet" onClick={() => setEditingLocation(false)}>Cancel</button>}
                  </div>
                  {pin.latitude == null && <p className="field-help">Use my location, search, or tap the map to place the pin.</p>}
                  {locationError && <div className="error-box" role="alert">{locationError}</div>}
                </>
              )}
            </div>
          </li>

          <li className={stepClass(pricesStep.done, 'prices')}>
            <div className="setup-step-head">
              {stepMark(pricesStep.done, 2)}
              <h2>Prices</h2>
              {status(pricesStep.done)}
            </div>
            <div className="setup-step-body">
              <div className="setup-step-summary">
                <p>Common prices are already set. {platformFeeLine(setup.platformMarkupBps) ?? ''}</p>
                <Link className="button-link secondary small" to="/dashboard/prices">Check prices</Link>
              </div>
            </div>
          </li>

          <li className={stepClass(pcDone, 'pc')}>
            <div className="setup-step-head">
              {stepMark(pcDone, 3)}
              <h2>Counter PC and printer</h2>
              {status(pcDone)}
            </div>
            <div className="setup-step-body">
              {agents.length === 0 ? (
                desktopApp ? (
                  <div className="setup-step-summary">
                    <p>Connect this computer. PrintQs Shop finds your printers by itself.</p>
                    <Link className="button-link" to="/dashboard/agents">Connect this computer</Link>
                  </div>
                ) : (
                  <>
                    <p className="setup-step-lead">PrintQs prints from the Windows computer next to your printer, with the free PrintQs Shop app.</p>
                    {phone && <PcLinkShare withQr />}
                    <PcSteps />
                    {!phone && <a className="button-link" href={WINDOWS_DOWNLOAD_URL}>Download PrintQs Shop for Windows</a>}
                  </>
                )
              ) : onlineAgents === 0 ? (
                <div className="setup-step-summary">
                  <p>Your counter PC is offline. Turn it on and open PrintQs Shop. Its printers show up here.</p>
                  <Link className="button-link secondary small" to="/dashboard/agents">Check counter PC</Link>
                </div>
              ) : detected.length > 0 ? (
                <>
                  <p className="setup-step-lead">
                    {detected.every((d) => isSimulatorPrinterName(d.name))
                      ? 'Your PC is connected, but it only found the practice simulator. It never prints student orders. To go live, open PrintQs Shop in Real printer mode on the computer with your printer.'
                      : 'Your PC is connected and found these printers. Add the one at your counter:'}
                  </p>
                  <DetectedPrinters detected={detected} isOwner onAdded={() => printerAdded()} />
                </>
              ) : practice ? (
                <div className="setup-step-summary">
                  <p><strong>Practice mode.</strong> Only the simulator is added, and it never prints student orders. Add your real printer to go live.</p>
                  <Link className="button-link secondary small" to="/dashboard/printers">Open printers</Link>
                </div>
              ) : (
                <div className="setup-step-summary">
                  <p>{pcStep.body}</p>
                  <Link className="button-link secondary small" to="/dashboard/printers">{pcStep.done ? 'See printers' : pcStep.action ?? 'Open printers'}</Link>
                </div>
              )}
            </div>
          </li>
        </ol>
      )}

      {setup && (state === 'not_ready' || state === 'pending_review') && setup.verification.autoLive === false && (
        <section className="notice info setup-review">
          <div>
            <strong>{setup.verification.status === 'submitted' ? 'Verification requested' : setup.verification.status === 'verified' ? 'Awaiting publication' : 'Request publication review'}</strong>
            <p>
              {setup.verification.status === 'submitted'
                ? 'Your shop is in the review queue. Students cannot find it until it is verified and published.'
                : setup.verification.status === 'verified'
                  ? 'Your shop is verified. PrintQs still needs to publish it before students can find it.'
                  : 'After the steps above are done, ask PrintQs to review your shop.'}
            </p>
          </div>
          {setup.verification.canSubmit && (
            <button type="button" onClick={() => void submitVerification()} disabled={submittingVerification}>
              {submittingVerification ? 'Sending…' : 'Request review'}
            </button>
          )}
        </section>
      )}

      {setup && listed && (
        <section className="share-panel">
          <div className="share-copy">
            <h2>Put this QR at your counter</h2>
            <p>Students scan it to upload from anywhere and pay you at the counter. They join your line only when they arrive.</p>
            <div className="copy-field">
              <code>{setup.studentUrl}</code>
              <button type="button" className="secondary small" onClick={() => void copyLink()}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <div className="row">
              <a className="button-link secondary" href={setup.studentUrl} target="_blank" rel="noreferrer">Open student page</a>
              {qr && <a className="text-link" href={qr} download="printqs-shop-qr.png">Download QR</a>}
            </div>
          </div>
          <div className="qr-frame">
            {qr ? <img src={qr} alt="QR code for your student ordering page" /> : <div className="skeleton-square" />}
          </div>
        </section>
      )}

      {error && <div className="error-box" role="alert">{error}</div>}
    </main>
  );
}
