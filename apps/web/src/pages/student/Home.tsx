import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ago, api, getToken, lastShopSlug, rememberShop, rupees } from '../../api.js';
import { statusMeta } from '../../jobStatus.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';
import InstallPrompt from '../../components/InstallPrompt.js';
import { IconChevron, IconPlus, IconStore } from '../../components/Icons.js';

interface JobRow {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  shop: { name: string; slug: string };
  file: { originalName: string };
}
interface Me {
  name: string | null;
  phone: string;
}

export default function Home() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickOpen, setPickOpen] = useState(params.get('pick') === '1');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('student')) {
      navigate('/login', { replace: true });
      return;
    }
    Promise.all([
      api<{ student: Me }>('/api/auth/student/me', { role: 'student' }),
      api<{ jobs: JobRow[] }>('/api/jobs', { role: 'student' }),
    ])
      .then(([m, j]) => {
        setMe(m.student);
        setJobs(j.jobs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load your prints'))
      .finally(() => setLoading(false));
  }, [navigate]);

  // distinct shops from history, most recent first
  const shops = useMemo(() => {
    const seen = new Map<string, { slug: string; name: string }>();
    for (const j of jobs) if (!seen.has(j.shop.slug)) seen.set(j.shop.slug, j.shop);
    return [...seen.values()];
  }, [jobs]);

  const active = jobs.filter((j) => statusMeta(j.status).active);
  const firstName = me?.name?.split(' ')[0] ?? 'there';

  function startPrint() {
    const slug = lastShopSlug() ?? shops[0]?.slug;
    if (slug && shops.length <= 1) navigate(`/s/${slug}`);
    else setPickOpen(true);
  }

  return (
    <StudentShell>
      <div className="page">
        <Topbar right={<Link to="/profile">Profile</Link>} />
        <div className="hero">
          <span className="hi">Hi {firstName} 👋</span>
        </div>

        <InstallPrompt />

        {error && <div className="error-box" role="alert">{error}</div>}

        <button className="cta-print" onClick={startPrint}>
          <span className="ic">
            <IconPlus />
          </span>
          <span style={{ flex: 1 }}>
            <strong>New print</strong>
            <span>Prepare it now, check in when you arrive</span>
          </span>
          <IconChevron />
        </button>

        {(pickOpen || shops.length > 1) && shops.length > 0 && (
          <>
            <div className="section-head">
              <h2>Your shops</h2>
            </div>
            <div className="shops-row">
              {shops.map((s) => (
                <button
                  key={s.slug}
                  className="shop-chip"
                  onClick={() => {
                    rememberShop(s.slug);
                    navigate(`/s/${s.slug}`);
                  }}
                >
                  <strong>{s.name}</strong>
                  <span>{s.slug}</span>
                </button>
              ))}
            </div>
          </>
        )}

        {active.length > 0 && (
          <>
            <div className="section-head">
              <h2>Happening now</h2>
              <Link to="/jobs">All jobs</Link>
            </div>
            {active.map((j) => {
              const m = statusMeta(j.status);
              return (
                <Link key={j.id} to={`/jobs/${j.id}`} className={`live-card ${j.status === 'notified' ? 'turn' : ''}`}>
                  <div className="row between">
                    <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {j.file.originalName}
                    </strong>
                    <span className={`stamp ${m.tone}`}>{m.label}</span>
                  </div>
                  <div className="dim" style={{ marginTop: 4 }}>
                    {j.shop.name}
                    {['awaiting_arrival', 'queued', 'notified'].includes(j.status) ? ' · tap for your counter code' : ''}
                  </div>
                </Link>
              );
            })}
          </>
        )}

        {!loading && jobs.length === 0 && (
          <div className="card" style={{ marginTop: 16 }}>
            <div className="row" style={{ gap: 12 }}>
              <span className="ic" style={{ color: 'var(--stamp)' }}>
                <IconStore />
              </span>
              <div>
                <strong>No prints yet</strong>
                <p className="dim" style={{ margin: '2px 0 0' }}>
                  Scan your shop's QR code, or <Link to="/s/demo">open the demo shop</Link> to try it.
                </p>
              </div>
            </div>
          </div>
        )}

        {jobs.length > 0 && (
          <>
            <div className="section-head">
              <h2>Recent</h2>
              <Link to="/jobs">See all</Link>
            </div>
            {jobs.slice(0, 3).map((j) => {
              const m = statusMeta(j.status);
              return (
                <Link key={j.id} to={`/jobs/${j.id}`} className="list-row" style={{ borderRadius: 12, border: '1px solid var(--rule)', background: 'var(--paper)', marginBottom: 8 }}>
                  <div className="lead">
                    <div style={{ minWidth: 0 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.file.originalName}
                      </div>
                      <div className="dim">{j.shop.name} · {ago(j.createdAt)}</div>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span className={`stamp ${m.tone}`}>{m.label}</span>
                    <div className="dim mono">{rupees(j.totalPaise)}</div>
                  </div>
                </Link>
              );
            })}
          </>
        )}
      </div>
    </StudentShell>
  );
}
