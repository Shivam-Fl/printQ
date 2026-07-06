import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import { enablePush, pushPermission } from '../../push.js';
import Topbar from '../../components/Topbar.js';

interface JobDetail {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  otpCode: string | null;
  otpExpiresAt: string | null;
  noShowCount: number;
  shop: { name: string; address: string; slug: string };
  file: { originalName: string };
}

const STAMP: Record<string, { text: string; tone: string }> = {
  pending_payment: { text: 'awaiting payment', tone: 'yellow' },
  queued: { text: 'in queue', tone: 'blue' },
  notified: { text: 'your turn', tone: 'yellow' },
  otp_verified: { text: 'sending to printer', tone: 'blue' },
  printing: { text: 'printing', tone: 'blue' },
  ready_for_pickup: { text: 'ready', tone: 'green' },
  completed: { text: 'completed', tone: 'green' },
  no_show: { text: 'missed turn', tone: 'red' },
  expired: { text: 'expired', tone: 'red' },
  cancelled: { text: 'cancelled', tone: 'red' },
};

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export default function JobStatus() {
  const { id = '' } = useParams();
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
      setCanRequeue(res.job.status === 'no_show' && res.job.noShowCount <= 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this job');
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const socket = getStudentSocket();
    if (!socket) return;
    const onUpdate = (p: {
      jobId: string;
      status?: string;
      position?: number | null;
      etaMinutes?: number | null;
      canRequeue?: boolean;
    }) => {
      if (p.jobId !== id) return;
      if (p.position !== undefined) setPosition(p.position);
      if (p.etaMinutes !== undefined) setEta(p.etaMinutes);
      if (p.canRequeue !== undefined) setCanRequeue(p.canRequeue);
      if (p.status) void refresh();
    };
    const onYourTurn = (p: { jobId: string; otp: string }) => {
      if (p.jobId !== id) return;
      setOtp(p.otp);
      void refresh();
    };
    socket.on('job:update', onUpdate);
    socket.on('job:your_turn', onYourTurn);
    return () => {
      socket.off('job:update', onUpdate);
      socket.off('job:your_turn', onYourTurn);
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
      <div className="page">
        <Topbar />
        <p className="dim">Loading…</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const stamp = STAMP[job.status] ?? { text: job.status, tone: 'blue' };
  const pendingSlot =
    job.mode === 'scheduled' &&
    job.status === 'queued' &&
    job.scheduledTime &&
    position === null;

  return (
    <div className="page">
      <Topbar right={<Link to="/jobs">My jobs</Link>} />
      <h1 style={{ wordBreak: 'break-word' }}>{job.file.originalName}</h1>
      <div className="row">
        <span className={`stamp ${stamp.tone}`}>{stamp.text}</span>
        <span className="dim">
          {job.shop.name} · <span className="mono">{rupees(job.totalPaise)}</span>
        </span>
      </div>

      {job.status === 'queued' && pendingSlot && (
        <div className="ticket">
          <div className="eyebrow">slot reserved</div>
          <div className="ticket-num" style={{ fontSize: '2.2rem' }}>
            {slotLabel(job.scheduledTime!)}
          </div>
          <div className="sub">We'll alert you when your slot opens. Nothing else to do now.</div>
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
          {otp ? (
            <div className="otp-band">{otp}</div>
          ) : (
            <div className="sub">Fetching your code…</div>
          )}
          {job.otpExpiresAt && (
            <div className="sub">
              valid till {new Date(job.otpExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          )}
        </div>
      )}

      {job.status === 'no_show' && (
        <div className="card stack">
          <p style={{ margin: 0 }}>You missed your window.</p>
          {canRequeue ? (
            <button onClick={requeue}>Requeue for free</button>
          ) : (
            <p className="dim" style={{ margin: 0 }}>
              This job can't be requeued — submit a new one.
            </p>
          )}
        </div>
      )}

      {job.status === 'ready_for_pickup' && (
        <div className="ticket turn">
          <div className="eyebrow">done</div>
          <div className="ticket-num" style={{ fontSize: '2rem' }}>
            Collect at counter
          </div>
        </div>
      )}

      {(job.status === 'queued' || job.status === 'notified') && !pushOffered && (
        <div className="card row between">
          <span className="dim" style={{ flex: 1 }}>
            Get an alert even if you close the app?
          </span>
          <button
            className="ghost small"
            onClick={async () => {
              await enablePush();
              setPushOffered(true);
            }}
          >
            Turn on alerts
          </button>
        </div>
      )}

      {(job.status === 'queued' || job.status === 'notified') && (
        <button className="ghost" onClick={cancel}>
          Cancel job
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
