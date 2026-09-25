import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api, getToken } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';

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
  };
}

const STEPS = [
  {
    key: 'profileReady' as const,
    number: '01',
    title: 'Confirm shop details',
    body: 'Check the shop name, campus and counter address students will see.',
    to: '/dashboard/settings',
    action: 'Review profile',
  },
  {
    key: 'locationReady' as const,
    number: '02',
    title: 'Secure the arrival zone',
    body: 'While at the counter, capture its location so remote users cannot take live queue positions.',
    to: '/dashboard/settings',
    action: 'Set counter location',
  },
  {
    key: 'pricingReady' as const,
    number: '03',
    title: 'Set services and prices',
    body: 'Configure paper, colour, duplex and binding prices once. Orders arrive fully specified.',
    to: '/dashboard/settings',
    action: 'Configure pricing',
  },
  {
    key: 'agentReady' as const,
    number: '04',
    title: 'Connect a shop computer',
    body: 'Run the PrintQ agent on the Windows PC that can already print to your devices.',
    to: '/dashboard/agents',
    action: 'Connect computer',
  },
  {
    key: 'printerReady' as const,
    number: '05',
    title: 'Review printer capabilities',
    body: 'Confirm loaded paper, colour support, finishing and speed so routing stays accurate.',
    to: '/dashboard/printers',
    action: 'Review printers',
  },
];

export default function ShopSetup() {
  const navigate = useNavigate();
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [submittingVerification, setSubmittingVerification] = useState(false);

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
          <p>Five practical steps. Most shops finish this in under ten minutes.</p>
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
            <strong>Your shop is verified and published.</strong>
            <p>Keep the agent running on the counter PC and share your student link.</p>
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
              <Link to={step.to}>{done ? 'Review' : step.action} →</Link>
            </section>
          );
        })}
      </div>

      {setup && !setup.ready && (
        <section className="share-panel">
          <div className="share-copy">
            <span className="eyebrow-label">Independent verification</span>
            <h2>{setup.verification.status === 'submitted' ? 'Verification requested' : setup.verification.status === 'verified' ? 'Awaiting publication' : 'Request publication review'}</h2>
            {setup.verification.status === 'submitted' ? (
              <p>Your configuration is in the platform review queue. Students cannot discover this counter until it is verified and published.</p>
            ) : setup.verification.status === 'verified' ? (
              <p>Your counter is verified. A platform administrator still needs to publish it before it is visible to students.</p>
            ) : (
              <p>After the five practical setup steps are complete, submit the counter for a platform review. This prevents unverified locations appearing to students.</p>
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
