import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, rememberShop, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import { enablePush, pushPermission } from '../../push.js';
import { specsText, statusMeta, type SpecsLite } from '../../jobStatus.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';

interface Breakdown {
  pagesPerCopy: number;
  copies: number;
  perPagePaise: number;
  pagesTotalPaise: number;
  bindingPaise: number;
  totalPaise: number;
}
interface JobDetail {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  priceBreakdown: Breakdown;
  specs: SpecsLite;
  createdAt: string;
  otpCode: string | null;
  otpExpiresAt: string | null;
  noShowCount: number;
  shop: { name: string; address: string; slug: string };
  file: { originalName: string; pages: number | null };
}

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

const MILESTONES = [
  { key: 'queued', label: 'In queue' },
  { key: 'notified', label: 'Your turn' },
  { key: 'printing', label: 'Printing' },
  { key: 'ready_for_pickup', label: 'Ready to collect' },
  { key: 'completed', label: 'Collected' },
];
const ORDER = ['pending_payment', 'queued', 'notified', 'otp_verified', 'printing', 'ready_for_pickup', 'completed'];

export default function JobStatus() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(null);
  const [canRequeue, setCanRequeue] = useState(false);
  const [pushOffered, setPushOffered] = useState(pushPermission() !== 'default');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ job: JobDetail }>(`/api/jobs/${id}`, { role: 'student' });
      setJob(res.job);
      if (res.job.otpCode) setOtp(res.job.otpCode);
      if (res.job.shop.slug) rememberShop(res.job.shop.slug);
      setCanRequeue(res.job.status === 'no_show' && res.job.noShowCount <= 1);
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
    const socket = getStudentSocket();
    if (!socket) return;
    const onUpdate = (p: { jobId: string; status?: string; position?: number | null; etaMinutes?: number | null; canRequeue?: boolean }) => {
      if (p.jobId !== id) return;
      if (p.position !== undefined) setPosition(p.position);
      if (p.etaMinutes !== undefined) setEta(p.etaMinutes);
      if (p.canRequeue !== undefined) setCanRequeue(p.canRequeue);
      if (p.status) void refresh();
    };
    const onTurn = (p: { jobId: string; otp: string }) => {
      if (p.jobId !== id) return;
      setOtp(p.otp);
      void refresh();
    };
    socket.on('job:update', onUpdate);
    socket.on('job:your_turn', onTurn);
    return () => {
      socket.off('job:update', onUpdate);
      socket.off('job:your_turn', onTurn);
    };
  }, [id, refresh]);

  async function requeue() {
    try {
      await api(`/api/jobs/${id}/requeue`, { method: 'POST', role: 'student' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Requeue failed');
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
  const b = job.priceBreakdown;
  const pendingSlot = job.mode === 'scheduled' && job.status === 'queued' && job.scheduledTime && position === null;
  const terminal = ['completed', 'expired', 'cancelled'].includes(job.status);
  const reachedIdx = ORDER.indexOf(job.status);

  return (
    <StudentShell>
      <div className="page">
        <Topbar right={<Link to="/jobs">My jobs</Link>} />
        <h1 style={{ wordBreak: 'break-word' }}>{job.file.originalName}</h1>
        <div className="row">
          <span className={`stamp ${m.tone}`}>{m.label}</span>
          <span className="dim">{job.shop.name}</span>
        </div>

        {/* ---- hero state ---- */}
        {pendingSlot && (
          <div className="ticket">
            <div className="eyebrow">slot reserved</div>
            <div className="ticket-num" style={{ fontSize: '2rem' }}>{slotLabel(job.scheduledTime!)}</div>
            <div className="sub">We'll alert you when your slot opens. Nothing to do till then.</div>
          </div>
        )}
        {job.status === 'queued' && !pendingSlot && (
          <div className="ticket">
            <div className="eyebrow">token · your place in line</div>
            <div className="ticket-num">{position ?? '·'}</div>
            <div className="sub">{eta !== null ? `about ${eta} min` : 'calculating wait…'}</div>
          </div>
        )}
        {job.status === 'notified' && (
          <div className="ticket turn">
            <div className="eyebrow">show this at the counter</div>
            {otp ? <div className="otp-band">{otp}</div> : <div className="sub">Fetching your code…</div>}
            {job.otpExpiresAt && (
              <div className="sub">valid till {new Date(job.otpExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            )}
          </div>
        )}
        {job.status === 'ready_for_pickup' && (
          <div className="ticket turn">
            <div className="eyebrow">done</div>
            <div className="ticket-num" style={{ fontSize: '1.7rem' }}>Collect at counter</div>
          </div>
        )}
        {job.status === 'no_show' && (
          <div className="card stack">
            <p style={{ margin: 0 }}>You missed your window.</p>
            {canRequeue ? (
              <button onClick={requeue}>Requeue for free</button>
            ) : (
              <p className="dim" style={{ margin: 0 }}>This job can't be requeued — start a new print.</p>
            )}
          </div>
        )}

        {/* ---- push nudge ---- */}
        {(job.status === 'queued' || job.status === 'notified') && !pushOffered && (
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
          <div className="line"><span>{b.pagesPerCopy} pages × {b.copies} {b.copies === 1 ? 'copy' : 'copies'}</span><span>{rupees(b.pagesTotalPaise)}</span></div>
          {b.bindingPaise > 0 && <div className="line"><span>binding</span><span>{rupees(b.bindingPaise)}</span></div>}
          <div className="line total"><span>Paid</span><span>{rupees(b.totalPaise)}</span></div>
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
                  const current = job.status === step.key || (step.key === 'printing' && job.status === 'otp_verified');
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

        {/* ---- actions ---- */}
        <div className="stack" style={{ marginTop: 8 }}>
          {(job.status === 'queued' || job.status === 'notified') && (
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
