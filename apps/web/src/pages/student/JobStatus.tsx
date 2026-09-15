import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, downloadFile, getToken, rememberShop, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import { enablePush, pushPermission } from '../../push.js';
import { specsText, statusMeta, type SpecsLite } from '../../jobStatus.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';

interface JobDetail {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  specs: SpecsLite;
  createdAt: string;
  otpCode: string | null;
  counterCodeAvailable: boolean;
  counterCodeThreshold: number;
  otpExpiresAt: string | null;
  noShowCount: number;
  paymentStatus: 'pending' | 'cash_due' | 'paid' | 'refunding' | 'refunded' | 'failed';
  paymentProvider: string | null;
  cashCollectedAt: string | null;
  rating: number | null;
  printError: string | null;
  printAttempts: number;
  position: number | null;
  etaMinutes: number | null;
  canCheckIn: boolean;
  checkInOpensAt: string | null;
  arrivedAt: string | null;
  checkInCount: number;
  shop: { name: string; address: string; slug: string };
  file: { originalName: string; pages: number | null };
}

type PaymentStatus = JobDetail['paymentStatus'];

export interface PaymentSummary {
  label: string;
  receiptAvailable: boolean;
  receiptMessage: string;
}

/** Keep the order total truthful: an order is not a paid order until the API says so. */
export function paymentSummary(
  paymentStatus: PaymentStatus,
  paymentProvider: string | null,
  cashCollectedAt: string | null,
): PaymentSummary {
  const cashCollected = paymentProvider === 'cash' && Boolean(cashCollectedAt);
  if (cashCollected || (paymentStatus === 'paid' && paymentProvider !== 'cash')) {
    return {
      label: paymentProvider === 'cash' ? 'Cash collected' : 'Amount paid',
      receiptAvailable: true,
      receiptMessage: '',
    };
  }

  switch (paymentStatus) {
    case 'cash_due':
      return { label: 'Cash due', receiptAvailable: false, receiptMessage: 'Receipt will be available after cash is collected at the counter.' };
    case 'refunding':
      return { label: 'Refund processing', receiptAvailable: false, receiptMessage: 'The payment is being refunded. The receipt will be available once processing is complete.' };
    case 'refunded':
      return { label: 'Refunded', receiptAvailable: false, receiptMessage: 'This payment was refunded, so there is no active payment receipt.' };
    case 'failed':
      return { label: 'Payment failed', receiptAvailable: false, receiptMessage: 'No receipt is available because the payment was not completed.' };
    case 'pending':
    default:
      return { label: 'Payment pending', receiptAvailable: false, receiptMessage: 'Receipt will be available after payment is confirmed.' };
  }
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

function currentLocation(): Promise<GeolocationPosition> {
  if (!navigator.geolocation) {
    return Promise.reject(new Error('This browser cannot verify your location. Show your counter code to staff.'));
  }
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      resolve,
      (reason) => reject(new Error(reason.code === reason.PERMISSION_DENIED
        ? 'Allow precise location to join the queue, or show your counter code to staff.'
        : 'Could not verify that you are at the shop. Move near the entrance and retry.')),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  });
}

export default function JobStatus() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [pushOffered, setPushOffered] = useState(pushPermission() !== 'default');
  const [error, setError] = useState('');
  const [confirmingArrival, setConfirmingArrival] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ job: JobDetail }>(`/api/jobs/${id}`, { role: 'student' });
      setJob(res.job);
      setPosition(res.job.position);
      setEta(res.job.etaMinutes);
      setOtp(res.job.otpCode);
      if (res.job.shop.slug) rememberShop(res.job.shop.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this job');
    }
  }, [id]);

  useEffect(() => {
    if (!getToken('student')) {
      navigate('/login', { replace: true });
      return;
    }
    void refresh();
  }, [refresh, navigate]);

  useEffect(() => {
    if (!job || !statusMeta(job.status).active) return;
    const poll = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(poll);
  }, [job?.status, refresh]);

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
      const position = await currentLocation();
      await api(`/api/jobs/${id}/check-in`, {
        method: 'POST',
        role: 'student',
        body: {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: position.coords.accuracy,
          measuredAt: new Date(position.timestamp).toISOString(),
        },
      });
      setConfirmingArrival(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join the live line');
    } finally {
      setCheckingIn(false);
    }
  }
  async function cancel() {
    if (!confirm('Cancel this print job?')) return;
    try {
      await api(`/api/jobs/${id}/cancel`, { method: 'POST', role: 'student' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cancel failed');
    }
  }

  async function rate(stars: number) {
    try {
      await api(`/api/jobs/${id}/rating`, { method: 'POST', role: 'student', body: { rating: stars } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save rating');
    }
  }

  if (!job) {
    return (
      <StudentShell>
        <div className="page">
          <Topbar right={<Link to="/jobs">My jobs</Link>} />
          <p className="dim">Loading…</p>
          {error && <p className="error">{error}</p>}
        </div>
      </StudentShell>
    );
  }

  const m = statusMeta(job.status);
  const checkInOpen = !job.checkInOpensAt || new Date(job.checkInOpensAt).getTime() <= Date.now();
  const pendingSlot = job.mode === 'scheduled' && job.status === 'awaiting_arrival' && !checkInOpen;
  const terminal = ['completed', 'expired', 'cancelled'].includes(job.status);
  const reachedIdx = ORDER.indexOf(job.status);
  const payment = paymentSummary(job.paymentStatus, job.paymentProvider, job.cashCollectedAt);

  return (
    <StudentShell>
      <div className="page">
        <Topbar right={<Link to="/jobs">My jobs</Link>} />
        <h1 style={{ wordBreak: 'break-word' }}>{job.file.originalName}</h1>
        <div className="row">
          <span className={`stamp ${m.tone}`}>{m.label}</span>
          <span className="dim">{job.shop.name}</span>
          {job.paymentStatus === 'refunding' && <span className="stamp yellow">refund processing</span>}
          {job.paymentStatus === 'refunded' && <span className="stamp green">refunded</span>}
        </div>

        {job.paymentProvider === 'cash' && job.paymentStatus === 'cash_due' && (
          <div className="notice cash-due-notice">
            <div>
              <strong>Pay {rupees(job.totalPaise)} in cash at the counter</strong>
              <p>Keep the exact total ready. Staff will confirm it before sending your document to the printer.</p>
            </div>
          </div>
        )}

        {/* ---- hero state ---- */}
        {pendingSlot && (
          <div className="ticket">
            <div className="eyebrow">planned arrival</div>
            <div className="ticket-num" style={{ fontSize: '2rem' }}>{slotLabel(job.scheduledTime!)}</div>
            <div className="sub">Your order is prepared. Check-in opens shortly before this time, after you reach the shop.</div>
          </div>
        )}
        {['awaiting_arrival', 'requeued'].includes(job.status) && !pendingSlot && (
          <div className="arrival-card">
            <div>
              <span className="eyebrow-label">Order prepared</span>
              <h2>Join only after you arrive</h2>
              <p>Your prepared order does not occupy the physical line. Check in at the shop entrance to receive a fair walk-in position.</p>
            </div>
            {!confirmingArrival ? (
              <button onClick={() => setConfirmingArrival(true)}>I’m at the shop</button>
            ) : (
              <div className="arrival-confirm">
                <strong>Are you physically at {job.shop.name}?</strong>
                <p>{job.checkInCount > 0
                 ? 'This is a new check-in, so you will join at the end of the current physical line. Your counter code has not changed.'
                   : 'This adds you to the live line now. If plans change, staff can remove you without cancelling your prepared order.'}</p>
                <div className="row">
                  <button disabled={checkingIn} onClick={checkIn}>{checkingIn ? 'Joining…' : 'Yes, join the line'}</button>
                  <button className="ghost" disabled={checkingIn} onClick={() => setConfirmingArrival(false)}>Not yet</button>
                </div>
              </div>
            )}
          </div>
        )}
        {['queued', 'notified'].includes(job.status) && !pendingSlot && (
          <div className="ticket">
            <div className="eyebrow">live walk-in position</div>
            <div className="ticket-num">{position === null ? '·' : `#${position}`}</div>
            <div className="sub">{eta !== null ? `roughly ${eta} min · stay near the counter` : 'position is advisory · stay near the counter'}</div>
          </div>
        )}
        {['queued', 'notified'].includes(job.status) && !otp && (
          <div className="card code-wait-card">
            <strong>Counter code unlocks automatically near your turn</strong>
            <p style={{ margin: 0 }}>
              It will appear here when you enter the first {job.counterCodeThreshold}. Keep watching your live position—there is nothing else to tap.
            </p>
          </div>
        )}
        {otp && ['awaiting_arrival', 'queued', 'notified', 'no_show', 'requeued', 'ready_for_pickup'].includes(job.status) && (
          <div className="ticket turn">
            <div className="eyebrow">your permanent counter code</div>
            <div className="otp-band">{otp}</div>
            <div className="sub">Tell this code to staff when you are at the counter. They can find and print your order even if your queue position was skipped.</div>
          </div>
        )}
        {job.status === 'ready_for_pickup' && (
          <div className="ticket turn">
            <div className="eyebrow">done</div>
            <div className="ticket-num" style={{ fontSize: '1.7rem' }}>Collect at counter</div>
          </div>
        )}
        {job.status === 'otp_verified' && job.printError && (
          <div className="notice setup-notice">
            <div><strong>The printer needs attention</strong><p>The shop has your verified order and can retry it without another OTP. You don’t need to rejoin the queue.</p></div>
          </div>
        )}
        {job.status === 'finishing' && (
          <div className="notice setup-notice">
            <div><strong>Printing is done</strong><p>The shop is completing your requested {job.specs.binding?.replace('_', ' ')} by hand. We’ll notify you as soon as collection is ready.</p></div>
          </div>
        )}
        {['no_show', 'requeued'].includes(job.status) && (
          <div className="card stack">
            <strong>Your prepared order is still available</strong>
            <p style={{ margin: 0 }}>{otp
              ? 'This order left the line. Your permanent counter code still identifies the document, or you can check in again at the end.'
              : 'This order left the line before its counter code unlocked. Check in again to join at the end of the current line.'}</p>
            <button disabled={checkingIn} onClick={checkIn}>{checkingIn ? 'Joining…' : 'I’m here — join live line'}</button>
          </div>
        )}
        {job.status === 'pending_payment' && (
          <div className="notice setup-notice">
            <div><strong>Payment wasn’t completed</strong><p>No queue position has been reserved. Cancel this attempt, then start again when you’re ready.</p></div>
          </div>
        )}

        {/* ---- push nudge ---- */}
        {['awaiting_arrival', 'queued', 'notified'].includes(job.status) && !pushOffered && (
          <div className="card row between">
            <span className="dim" style={{ flex: 1 }}>Get alerted even if you close the app?</span>
            <button className="ghost small" onClick={async () => { await enablePush(); setPushOffered(true); }}>
              Turn on
            </button>
          </div>
        )}

        {/* ---- details ---- */}
        <div className="section-head"><h2>Print details</h2></div>
        <div className="card">
          <div className="spec-grid">
            <div><div className="k">Copies</div><div className="v">{job.specs.copies}</div></div>
            <div><div className="k">Paper</div><div className="v">{job.specs.paperSize}</div></div>
            <div><div className="k">Colour</div><div className="v">{job.specs.color ? 'Colour' : 'B/W'}</div></div>
            <div><div className="k">Sides</div><div className="v">{job.specs.duplex ? 'Both' : 'One'}</div></div>
            <div><div className="k">Binding</div><div className="v">{job.specs.binding ? job.specs.binding.replace('_', ' ') : 'None'}</div></div>
            <div><div className="k">Pages</div><div className="v">{job.specs.pageRange ?? 'All'}{job.file.pages ? ` / ${job.file.pages}` : ''}</div></div>
          </div>
        </div>

        {/* ---- receipt ---- */}
        <div className="card receipt">
          <div className="line total"><span>{payment.label}</span><span>{rupees(job.totalPaise)}</span></div>
          {payment.receiptAvailable ? (
            <button
              className="ghost small"
              style={{ marginTop: 10 }}
              onClick={() =>
                downloadFile(`/api/jobs/${job.id}/receipt`, 'student', `printq-receipt-${job.id.slice(0, 8)}.pdf`).catch(
                  () => setError('Could not download receipt'),
                )
              }
            >
              Download receipt
            </button>
          ) : (
            <p className="receipt-help">{payment.receiptMessage}</p>
          )}
        </div>

        {/* ---- timeline (only for the normal path) ---- */}
        {!['expired', 'cancelled', 'no_show'].includes(job.status) && (
          <>
            <div className="section-head"><h2>Progress</h2></div>
            <div className="card">
              <ul className="timeline">
                {MILESTONES.map((step) => {
                  const stepIdx = ORDER.indexOf(step.key);
                  const done = reachedIdx > stepIdx;
                  const current =
                    job.status === step.key ||
                    (step.key === 'queued' && job.status === 'notified') ||
                    (step.key === 'printing' && job.status === 'otp_verified');
                  return (
                    <li key={step.key} className={done ? 'done' : current ? 'current' : ''}>
                      <div className="t">{step.label}</div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </>
        )}

        {/* ---- rating ---- */}
        {job.status === 'completed' && (
          <div className="card">
            {job.rating ? (
              <p style={{ margin: 0 }}>You rated this print {'★'.repeat(job.rating)}{'☆'.repeat(5 - job.rating)}</p>
            ) : (
              <>
                <strong>How was this print?</strong>
                <div className="row" style={{ marginTop: 8 }}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} className="ghost" style={{ fontSize: '1.2rem', padding: '6px 10px' }} onClick={() => rate(n)}>
                      {'★'.repeat(n)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ---- actions ---- */}
        <div className="stack" style={{ marginTop: 8 }}>
          {['pending_payment', 'awaiting_arrival', 'queued', 'notified'].includes(job.status) && (
            <button className="ghost" onClick={cancel}>Cancel job</button>
          )}
          {terminal && (
            <button onClick={() => { rememberShop(job.shop.slug); navigate(`/s/${job.shop.slug}`); }}>
              Print again at {job.shop.name}
            </button>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </StudentShell>
  );
}
