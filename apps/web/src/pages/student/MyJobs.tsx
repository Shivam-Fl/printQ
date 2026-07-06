import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ago, api, getToken, rupees } from '../../api.js';
import { specsText, statusMeta, type SpecsLite } from '../../jobStatus.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';

interface JobRow {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  totalPaise: number;
  pagesPerCopy: number;
  createdAt: string;
  specs: SpecsLite;
  shop: { name: string; slug: string };
  file: { originalName: string };
}

function JobCard({ job }: { job: JobRow }) {
  const m = statusMeta(job.status);
  return (
    <Link to={`/jobs/${job.id}`} className="card" style={{ display: 'block', color: 'inherit', padding: 14 }}>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {job.file.originalName}
          </div>
          <div className="dim" style={{ marginTop: 2 }}>{specsText(job.specs, job.pagesPerCopy)}</div>
          <div className="dim" style={{ marginTop: 2 }}>
            {job.shop.name}
            {job.mode === 'scheduled' && job.scheduledTime
              ? ` · slot ${new Date(job.scheduledTime).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
              : ` · ${ago(job.createdAt)}`}
          </div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          <span className={`stamp ${m.tone}`}>{m.label}</span>
          <div className="dim mono" style={{ marginTop: 6 }}>{rupees(job.totalPaise)}</div>
        </div>
      </div>
    </Link>
  );
}

export default function MyJobs() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('student')) {
      navigate('/login', { replace: true });
      return;
    }
    api<{ jobs: JobRow[] }>('/api/jobs', { role: 'student' })
      .then((r) => setJobs(r.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [navigate]);

  const active = jobs?.filter((j) => statusMeta(j.status).active) ?? [];
  const history = jobs?.filter((j) => !statusMeta(j.status).active) ?? [];

  return (
    <StudentShell>
      <div className="page">
        <Topbar right={<Link to="/profile">Profile</Link>} />
        <h1>My jobs</h1>
        {error && <p className="error">{error}</p>}

        {jobs && jobs.length === 0 && (
          <div className="card">
            <p style={{ margin: 0 }}>No prints yet.</p>
            <p className="dim" style={{ marginBottom: 0 }}>
              Tap <strong>Print</strong> below, or <Link to="/s/demo">try the demo shop</Link>.
            </p>
          </div>
        )}

        {active.length > 0 && (
          <>
            <div className="section-head"><h2>Active</h2></div>
            <div className="stack">{active.map((j) => <JobCard key={j.id} job={j} />)}</div>
          </>
        )}

        {history.length > 0 && (
          <>
            <div className="section-head"><h2>History</h2></div>
            <div className="stack">{history.map((j) => <JobCard key={j.id} job={j} />)}</div>
          </>
        )}
      </div>
    </StudentShell>
  );
}
