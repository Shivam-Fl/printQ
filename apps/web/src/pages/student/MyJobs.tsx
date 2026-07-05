import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, rupees } from '../../api.js';

interface JobRow {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  shop: { name: string; slug: string };
  file: { originalName: string };
}

export default function MyJobs() {
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ jobs: JobRow[] }>('/api/jobs', { role: 'student' })
      .then((r) => setJobs(r.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, []);

  return (
    <div className="page">
      <div className="topbar">
        <span className="brand">PrintQ</span>
      </div>
      <h1>My jobs</h1>
      {error && <p className="error">{error}</p>}
      {jobs?.length === 0 && <p className="dim">Nothing yet — scan your shop's QR to start.</p>}
      {jobs?.map((job) => (
        <Link key={job.id} to={`/jobs/${job.id}`} style={{ color: 'inherit' }}>
          <div className="card row between">
            <div>
              <div>{job.file.originalName}</div>
              <div className="dim">
                {job.shop.name} · {new Date(job.createdAt).toLocaleString()}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className="badge accent">{job.status.replace(/_/g, ' ')}</span>
              <div className="dim">{rupees(job.totalPaise)}</div>
            </div>
          </div>
        </Link>
      ))}
    </div>
  );
}
