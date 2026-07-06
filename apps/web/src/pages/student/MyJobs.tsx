import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getToken, rupees } from '../../api.js';
import Topbar from '../../components/Topbar.js';

interface JobRow {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  createdAt: string;
  shop: { name: string; slug: string };
  file: { originalName: string };
}

const TONE: Record<string, string> = {
  queued: 'blue',
  notified: 'yellow',
  printing: 'blue',
  otp_verified: 'blue',
  ready_for_pickup: 'green',
  completed: 'green',
  no_show: 'red',
  expired: 'red',
  cancelled: 'red',
  pending_payment: 'yellow',
};

export default function MyJobs() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState('');
  const loggedIn = Boolean(getToken('student'));

  useEffect(() => {
    if (!loggedIn) return;
    api<{ jobs: JobRow[] }>('/api/jobs', { role: 'student' })
      .then((r) => setJobs(r.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [loggedIn]);

  return (
    <div className="page">
      <Topbar tag="skip the line" />
      <h1>My jobs</h1>
      {!loggedIn && (
        <div className="card">
          <p style={{ marginTop: 0 }}>Scan your shop's QR code (or open its link) to send a print.</p>
          <p className="dim" style={{ marginBottom: 0 }}>
            Trying it out? <Link to="/s/demo">Open the demo shop →</Link>
          </p>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {jobs?.length === 0 && (
        <div className="card">
          <p style={{ margin: 0 }}>Nothing here yet — open your shop's link to send your first print.</p>
        </div>
      )}
      {jobs?.map((job) => (
        <Link key={job.id} to={`/jobs/${job.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
          <div className="card row between" style={{ padding: 14 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {job.file.originalName}
              </div>
              <div className="dim">
                {job.shop.name}
                {job.mode === 'scheduled' && job.scheduledTime
                  ? ` · slot ${new Date(job.scheduledTime).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                  : ` · ${new Date(job.createdAt).toLocaleDateString()}`}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <span className={`stamp ${TONE[job.status] ?? 'blue'}`}>{job.status.replace(/_/g, ' ')}</span>
              <div className="dim mono">{rupees(job.totalPaise)}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
