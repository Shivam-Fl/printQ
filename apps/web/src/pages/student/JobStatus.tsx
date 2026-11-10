import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile, getToken, rememberShop, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import { enablePush, pushPermission } from '../../push.js';
import { jobBadge, stampClass, statusMeta, type SpecsLite } from '../../jobStatus.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';
import { StudentBandPanel, codeHalves, useNow } from '../../components/QueueBand.js';
import { studentLoginPath } from '../../lib/studentReturn.js';
import type { QueueBand } from '@printq/shared';
import { paymentSummary, type PaymentStatus } from './jobPayment.js';

export interface JobDetail {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  specs: SpecsLite;
  createdAt: string;
  otpCode: string | null;
  counterCodeAvailable: boolean;
  /** Server-computed counter band (revealed / arriving / waiting) or null outside the line. */
  band: QueueBand | null;
  /** When a revealed student must be at the counter; null = no timer running. */
  revealDeadlineAt: string | null;
  /** Missed their turn: back in prepared state, must check in again. */
  absent: boolean;
  otpExpiresAt: string | null;
  noShowCount: number;
  paymentStatus: PaymentStatus;
  rating: number | null;
  printError: string | null;
  printAttempts: number;
  position: number | null;
  etaMinutes: number | null;
  canCheckIn: boolean;
  checkInOpensAt: string | null;
  arrivedAt: string | null;
  checkInCount: number;
  shop: {
    name: string;
    address: string;
    slug: string;
    counterUpi: { vpa: string; payeeName: string } | null;
  };
  file: { originalName: string; pages: number | null };
}

/** Shape of POST /api/jobs/:id/check-in (live queue metrics included). */
export interface CheckInResult {
  id: string;
  status: string;
  position: number | null;
  etaMinutes: number | null;
  band: QueueBand | null;
  revealDeadlineAt: string | null;
}

/** Optimistic job state straight from the check-in response. */
export function applyCheckInResult(job: JobDetail, r: CheckInResult): JobDetail {
  return {
    ...job,
    status: r.status,
    position: r.position,
    etaMinutes: r.etaMinutes,
    band: r.band,
    revealDeadlineAt: r.revealDeadlineAt,
    absent: false,
    canCheckIn: false,
    arrivedAt: job.arrivedAt ?? new Date().toISOString(),
    checkInCount: job.status === 'queued' ? job.checkInCount : job.checkInCount + 1,
  };
}

/** Opens the shop's verified merchant VPA with the exact final amount. */
export function counterUpiIntentUri(
  vpa: string,
  payeeName: string,
  totalPaise: number,
  jobId: string,
): string {
  if (!Number.isInteger(totalPaise) || totalPaise < 100) throw new RangeError('Invalid counter payment amount');
  const params = new URLSearchParams({
    pa: vpa,
    pn: payeeName,
    am: (totalPaise / 100).toFixed(2),
    cu: 'INR',
    tn: `PrintQs ${jobId.slice(0, 8)}`,
  });
  return `upi://pay?${params.toString()}`;
}

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const MILESTONES = [
  { key: 'awaiting_arrival', label: 'Prepared' },
  { key: 'queued', label: 'Checked in' },
  { key: 'printing', label: 'Printing' },
  { key: 'finishing', label: 'Finishing' },
  { key: 'ready_for_pickup', label: 'Ready to collect' },
  { key: 'completed', label: 'Collected' },
];
const ORDER = ['pending_payment', 'awaiting_arrival', 'queued', 'notified', 'otp_verified', 'printing', 'finishing', 'ready_for_pickup', 'completed'];

const bindingWords = (binding: string | null) => (binding ? binding.replace(/_/g, ' ') : null);

function currentLocation(): Promise<GeolocationPosition> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('This browser cannot check your location. Show your order to staff at the counter.'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (reason) => reject(new Error(reason.code === reason.PERMISSION_DENIED
        ? 'Allow location for PrintQs to join the line, or show your order to staff.'
        : 'Could not confirm you are at the shop. Move near the entrance and try again.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  });
}

export default function JobStatus() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const loginPath = studentLoginPath(location.pathname + location.search);
  const [job, setJob] = useState<JobDetail | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [pushOffered, setPushOffered] = useState(pushPermission() !== 'default');
  const [error, setError] = useState('');
  const [checkingIn, setCheckingIn] = useState(false);
  const nowMs = useNow(Boolean(job?.revealDeadlineAt));

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ job: JobDetail }>(`/api/jobs/${id}`, { role: 'student' });
      setJob(res.job);
      setPosition(res.job.position);
      setEta(res.job.etaMinutes);
      setOtp(res.job.otpCode);
      if (res.job.shop.slug) rememberShop(res.job.shop.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this order.');
    }
  }, [id]);

  useEffect(() => {
    if (!getToken('student')) {
      navigate(loginPath, { replace: true });
      return;
    }
    void refresh();
  }, [refresh, navigate, loginPath]);

  useEffect(() => {
    if (!job || !statusMeta(job.status).active) return;
    const poll = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(poll);
  }, [job?.status, refresh]);

  const deadlineAt = job?.revealDeadlineAt ?? null;
  useEffect(() => {
    if (!deadlineAt) return;
    const wait = Math.max(0, new Date(deadlineAt).getTime() - Date.now()) + 1_500;
    const timer = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(timer);
  }, [deadlineAt, refresh]);

  useEffect(() => {
    const socket = getStudentSocket();
    if (!socket) return;
    const onUpdate = (p: {
      jobId: string;
      status?: string;
      position?: number | null;
      etaMinutes?: number | null;
      counterCodeAvailable?: boolean;
      canRequeue?: boolean;
    }) => {
      if (p.jobId !== id) return;
      if (p.position !== undefined) setPosition(p.position);
      if (p.etaMinutes !== undefined) setEta(p.etaMinutes);
      if (p.status || p.counterCodeAvailable) void refresh();
    };
    socket.on('job:update', onUpdate);
    return () => {
      socket.off('job:update', onUpdate);
    };
  }, [id, refresh]);

  async function checkIn() {
    setCheckingIn(true);
    setError('');
    try {
      const where = await currentLocation();
      const res = await api<{ job: CheckInResult }>(`/api/jobs/${id}/check-in`, {
        method: 'POST',
        role: 'student',
        body: {
          latitude: where.coords.latitude,
          longitude: where.coords.longitude,
          accuracyM: where.coords.accuracy,
          measuredAt: new Date(where.timestamp).toISOString(),
        },
      });
      // The server already answered with the new place: show it now, let the refresh fetch the code.
      setJob((prev) => (prev ? applyCheckInResult(prev, res.job) : prev));
      setPosition(res.job.position);
      setEta(res.job.etaMinutes);
      void refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the line. Try again.');
    } finally {
      setCheckingIn(false);
    }
  }

  async function cancel() {
    if (!confirm('Cancel this order? You have not paid anything yet.')) return;
    try {
      await api(`/api/jobs/${id}/cancel`, { method: 'POST', role: 'student' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel. Try again.');
    }
  }

  async function rate(stars: number) {
    try {
      await api(`/api/jobs/${id}/rating`, { method: 'POST', role: 'student', body: { rating: stars } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your rating.');
    }
  }

  if (!job) {
    return (
      <StudentShell>
        <div className="page job-page">
          <Topbar right={<Link to="/jobs">My jobs</Link>} />
          {error ? (
            <div className="empty-state" role="alert">
              <strong>Could not load this order</strong>
              <p>{error}</p>
              <button type="button" onClick={() => { setError(''); void refresh(); }} style={{ marginTop: 14 }}>Try again</button>
            </div>
          ) : (
            <div className="skeleton-list" role="status" aria-label="Loading your order">
              <div className="skeleton-card" style={{ height: 64 }} />
              <div className="skeleton-card" style={{ height: 220 }} />
            </div>
          )}
        </div>
      </StudentShell>
    );
  }

  const checkInOpen = !job.checkInOpensAt || new Date(job.checkInOpensAt).getTime() <= Date.now();
  const pendingSlot = job.mode === 'scheduled' && job.status === 'awaiting_arrival' && !checkInOpen;
  const terminal = ['completed', 'expired', 'cancelled'].includes(job.status);
  const reachedIdx = ORDER.indexOf(job.status);
  const payment = paymentSummary(job.paymentStatus, job.status);
  const badge = jobBadge({ status: job.status, band: job.band, absent: job.absent });
  const inLine = ['queued', 'notified'].includes(job.status);
  const prepared = ['awaiting_arrival', 'requeued', 'no_show'].includes(job.status);
  const owes = (job.paymentStatus === 'counter_due' || job.paymentStatus === 'cash_due') && !terminal;
  const binding = bindingWords(job.specs.binding);

  const checkInButton = (label: string) => (
    <button type="button" className="large full-button" disabled={checkingIn} onClick={() => void checkIn()}>
      {checkingIn ? 'Checking your location…' : label}
    </button>
  );

  return (
    <StudentShell>
      <div className="page job-page">
        <Topbar right={<Link to="/jobs">My jobs</Link>} />
        <header className="job-head">
          <p className="job-shop">{job.shop.name}</p>
          <h1 className="job-title">{job.file.originalName}</h1>
          <div className="row">
            <span className={stampClass(badge.tone)}>{badge.label}</span>
            {job.paymentStatus === 'refunding' && <span className="stamp yellow">refund processing</span>}
            {job.paymentStatus === 'refunded' && <span className="stamp green">refunded</span>}
          </div>
        </header>

        {/* ---- the one "what to do now" card ---- */}
        {pendingSlot && (
          <div className="now-card">
            <p className="now-kicker">Planned visit</p>
            <p className="now-title">{slotLabel(job.scheduledTime!)}</p>
            <p className="now-body">
              Your order is ready. Check-in opens at {slotLabel(job.checkInOpensAt ?? job.scheduledTime!)}: tap I’m here when you reach {job.shop.name}.
            </p>
          </div>
        )}
        {prepared && !pendingSlot && job.absent && (
          <div className="now-card danger" role="alert">
            <p className="now-kicker">You missed your turn</p>
            <p className="now-body">Your order and your code still work. Check in again to join at the end of the line.</p>
            {checkInButton('I’m here, check in again')}
          </div>
        )}
        {prepared && !pendingSlot && !job.absent && (
          <div className="now-card">
            <p className="now-kicker">Next step</p>
            <p className="now-title">Go to {job.shop.name}</p>
            {job.shop.address && <p className="now-body">{job.shop.address}</p>}
            {checkInButton('I’m here')}
            <p className="now-note">
              Tap it at the shop. We check your location once, you join the line, and your code appears when it is your turn.
            </p>
          </div>
        )}
        {inLine && !pendingSlot && (
          <StudentBandPanel
            nowMs={nowMs}
            job={{ status: job.status, position, etaMinutes: eta, band: job.band, revealDeadlineAt: job.revealDeadlineAt, otpCode: otp }}
          />
        )}
        {job.status === 'otp_verified' && (
          <div className={`now-card${job.printError ? ' warn' : ''}`} role="status">
            <p className="now-kicker">{job.printError ? 'The printer had a problem' : 'Sending to the printer'}</p>
            <p className="now-body">
              {job.printError
                ? 'Staff will print it again. You do not need to do anything or check in again.'
                : 'Your order is on its way to the printer.'}
            </p>
          </div>
        )}
        {job.status === 'printing' && (
          <div className="now-card" role="status">
            <p className="now-kicker">Printing now</p>
            <p className="now-body">Wait near the counter. Staff hand it over when it is done.</p>
          </div>
        )}
        {job.status === 'finishing' && (
          <div className="now-card" role="status">
            <p className="now-kicker">{binding ? `${binding.charAt(0).toUpperCase()}${binding.slice(1)} by hand` : 'Finishing by hand'}</p>
            <p className="now-body">Your pages are printed. We will tell you when it is ready to collect.</p>
          </div>
        )}
        {job.status === 'ready_for_pickup' && (
          <div className="ticket turn ready-ticket" data-band="ready">
            <p className="ticket-title">Ready to collect</p>
            {otp && (
              <div className="otp-band" data-counter-code aria-label={`Counter code ${otp.split('').join(' ')}`}>
                {codeHalves(otp).map((half, i) => <span key={i} aria-hidden>{half}</span>)}
              </div>
            )}
            <p className="sub">Show this at the counter to collect your prints.</p>
          </div>
        )}
        {job.status === 'pending_payment' && (
          <div className="now-card" role="status">
            <p className="now-kicker">Preparing your order</p>
            <p className="now-body">This takes a moment. No place in line is held yet.</p>
          </div>
        )}
        {job.status === 'completed' && (
          <div className="now-card ok">
            <p className="now-kicker">Collected</p>
            {job.rating ? (
              <p className="now-body">You rated this print {job.rating} out of 5.</p>
            ) : (
              <>
                <p className="now-body">How was this print?</p>
                <div className="rating-row" role="group" aria-label="Rate this print">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} type="button" className="secondary" aria-label={`${n} out of 5`} onClick={() => void rate(n)}>
                      {n} <span aria-hidden>★</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
        {(job.status === 'cancelled' || job.status === 'expired') && (
          <div className="now-card">
            <p className="now-kicker">{job.status === 'expired' ? 'This order expired' : 'Order cancelled'}</p>
            <p className="now-body">{payment.nothingCharged ? 'Nothing was charged.' : payment.receiptMessage || payment.label}</p>
          </div>
        )}

        {error && <p className="error-box" role="alert">{error}</p>}

        {/* ---- how to pay (after the code: at the counter the code matters first) ---- */}
        {owes && (inLine || prepared || job.status === 'pending_payment') && (
          <div className="pay-line">
            <div>
              <strong>Pay {rupees(job.totalPaise)} at the counter</strong>
              <span>Cash or UPI. Staff confirm it before printing.</span>
            </div>
            {job.shop.counterUpi && inLine && (
              <a className="button-link secondary" href={counterUpiIntentUri(job.shop.counterUpi.vpa, job.shop.counterUpi.payeeName, job.totalPaise, job.id)}>
                Pay by UPI
              </a>
            )}
          </div>
        )}

        {(prepared || inLine) && !pushOffered && (
          <div className="push-nudge">
            <span>Get an alert when it is your turn, even with the app closed.</span>
            <button type="button" className="secondary small" onClick={async () => { await enablePush(); setPushOffered(true); }}>
              Turn on alerts
            </button>
          </div>
        )}

        {/* ---- details ---- */}
        <section className="job-section" aria-labelledby="order-details">
          <h2 id="order-details">Your order</h2>
          <div className="card">
            <div className="spec-grid">
              <div><div className="k">Copies</div><div className="v">{job.specs.copies}</div></div>
              <div><div className="k">Paper</div><div className="v">{job.specs.paperSize}</div></div>
              <div><div className="k">Colour</div><div className="v">{job.specs.color ? 'Colour' : 'Black & white'}</div></div>
              <div><div className="k">Sides</div><div className="v">{job.specs.duplex ? 'Both sides' : 'One side'}</div></div>
              <div><div className="k">Binding</div><div className="v">{binding ?? 'None'}</div></div>
              <div><div className="k">Pages</div><div className="v">{job.specs.pageRange ?? 'All'}{job.file.pages ? ` of ${job.file.pages}` : ''}</div></div>
            </div>
            <div className="receipt job-total">
              <div className="line total">
                <span>{payment.label}</span>
                <span>{payment.nothingCharged ? <s>{rupees(job.totalPaise)}</s> : rupees(job.totalPaise)}</span>
              </div>
            </div>
            {payment.receiptAvailable ? (
              <button
                type="button"
                className="secondary small"
                onClick={() =>
                  downloadFile(`/api/jobs/${job.id}/receipt`, 'student', `printq-receipt-${job.id.slice(0, 8)}.pdf`).catch(
                    () => setError('Could not download the receipt. Try again.'),
                  )
                }
              >
                Download receipt
              </button>
            ) : (
              <p className="receipt-help dim">{payment.receiptMessage}</p>
            )}
          </div>
        </section>

        {!['expired', 'cancelled', 'no_show'].includes(job.status) && (
          <section className="job-section" aria-labelledby="order-progress">
            <h2 id="order-progress">Progress</h2>
            <div className="card">
              <ul className="timeline">
                {MILESTONES.filter((step) => step.key !== 'finishing' || job.specs.binding).map((step) => {
                  const stepIdx = ORDER.indexOf(step.key);
                  const done = reachedIdx > stepIdx;
                  const current =
                    job.status === step.key ||
                    (step.key === 'queued' && job.status === 'notified') ||
                    (step.key === 'printing' && job.status === 'otp_verified');
                  return (
                    <li key={step.key} className={done ? 'done' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
                      <div className="t">{step.label}</div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        )}

        <div className="job-foot">
          {terminal && (
            <button type="button" className="large full-button" onClick={() => { rememberShop(job.shop.slug); navigate(`/s/${job.shop.slug}`); }}>
              Print again at {job.shop.name}
            </button>
          )}
          {['pending_payment', 'awaiting_arrival', 'queued', 'notified'].includes(job.status) && (
            <button type="button" className="quiet danger-text" onClick={() => void cancel()}>Cancel order</button>
          )}
        </div>
      </div>
    </StudentShell>
  );
}
