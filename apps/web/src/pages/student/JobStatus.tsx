import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';

interface JobDetail {
  id: string;
  status: string;
  totalPaise: number;
  otpExpiresAt: string | null;
  noShowCount: number;
  shop: { name: string; address: string; slug: string };
  file: { originalName: string };
}

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  pending_payment: { text: 'Awaiting payment', tone: 'warn' },
  queued: { text: 'In queue', tone: 'accent' },
  notified: { text: 'Your turn — go to the counter!', tone: 'ok' },
  otp_verified: { text: 'Releasing to printer…', tone: 'accent' },
  printing: { text: 'Printing…', tone: 'accent' },
  ready_for_pickup: { text: 'Ready — collect your print', tone: 'ok' },
  completed: { text: 'Completed', tone: 'ok' },
  no_show: { text: 'Missed your turn', tone: 'danger' },
  expired: { text: 'Expired', tone: 'danger' },
  cancelled: { text: 'Cancelled', tone: 'danger' },
};

export default function JobStatus() {
  const { id = '' } = useParams();
  const [job, setJob] = useState<JobDetail | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const [otp, setOtp] = useState<string | null>(() => localStorage.getItem(`printq:otp:${id}`));
  const [canRequeue, setCanRequeue] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ job: JobDetail }>(`/api/jobs/${id}`, { role: 'student' });
      setJob(res.job);
      setCanRequeue(res.job.status === 'no_show' && res.job.noShowCount <= 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load job');
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
    const onYourTurn = (p: { jobId: string; otp: string }) => {
      if (p.jobId !== id) return;
      setOtp(p.otp);
      localStorage.setItem(`printq:otp:${id}`, p.otp);
      void refresh();
    };
    socket.on('job:update', onUpdate);
    socket.on('job:your_turn', onYourTurn);
    return () => {
      socket.off('job:update', onUpdate);
      socket.off('job:your_turn', onYourTurn);
    };
  }, [id, refresh]);

  // OTP is single-use and job-bound; drop it once the job moves past release
  useEffect(() => {
    if (job && ['otp_verified', 'printing', 'ready_for_pickup', 'completed', 'expired', 'cancelled'].includes(job.status)) {
      localStorage.removeItem(`printq:otp:${id}`);
    }
  }, [job, id]);

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
        <p className="dim">Loading…</p>
        {error && <p className="error">{error}</p>}
      </div>
    );
  }

  const label = STATUS_LABEL[job.status] ?? { text: job.status, tone: 'accent' };

  return (
    <div className="page">
      <div className="topbar">
        <span className="brand">PrintQ</span>
        <Link to="/jobs">My jobs</Link>
      </div>
      <h1>{job.file.originalName}</h1>
      <p className="dim">{job.shop.name} · {rupees(job.totalPaise)}</p>
      <span className={`badge ${label.tone}`}>{label.text}</span>

      {job.status === 'queued' && (
        <div className="card">
          <div className="dim" style={{ textAlign: 'center' }}>Your place in line</div>
          <div className="queue-pos">{position ?? '…'}</div>
          {eta !== null && <p className="dim" style={{ textAlign: 'center' }}>~{eta} min wait</p>}
          <p className="dim" style={{ textAlign: 'center' }}>
            We'll send your OTP on WhatsApp when it's your turn — keep this page open for live updates.
          </p>
        </div>
      )}

      {job.status === 'notified' && (
        <div className="card">
          <p style={{ textAlign: 'center', margin: '4px 0' }}>Tell this code at the counter:</p>
          {otp ? (
            <div className="big-otp">{otp}</div>
          ) : (
            <p className="dim" style={{ textAlign: 'center' }}>Check WhatsApp for your OTP.</p>
          )}
          {job.otpExpiresAt && (
            <p className="dim" style={{ textAlign: 'center' }}>
              Valid until {new Date(job.otpExpiresAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}

      {job.status === 'no_show' && (
        <div className="card stack">
          <p>You missed your window.</p>
          {canRequeue ? (
            <button onClick={requeue}>Requeue for free</button>
          ) : (
            <p className="dim">This job can no longer be requeued.</p>
          )}
        </div>
      )}

      {job.status === 'ready_for_pickup' && (
        <div className="card">
          <p>Your print is done — collect it at the counter. 🎉</p>
        </div>
      )}

      {(job.status === 'queued' || job.status === 'notified') && (
        <button className="ghost" onClick={cancel}>Cancel job</button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
