import { useEffect, useMemo, useRef, useState } from 'react';
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

export type NewPrintAction =
  | { kind: 'shop'; slug: string }
  | { kind: 'picker' }
  | { kind: 'directory' };

export function resolveNewPrintAction(
  _rememberedSlug: string | null,
  shops: Array<{ slug: string }>,
): NewPrintAction {
  const onlyShop = shops[0];
  if (onlyShop && shops.length === 1) return { kind: 'shop', slug: onlyShop.slug };
  if (shops.length > 0) return { kind: 'picker' };
  return { kind: 'directory' };
}

export default function Home() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [me, setMe] = useState<Me | null>(null);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pickOpen, setPickOpen] = useState(params.get('pick') === '1');
  const [error, setError] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerHeadingRef = useRef<HTMLHeadingElement>(null);

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

  useEffect(() => {
    if (loading || !pickOpen || shops.length > 0) return;
    navigate('/shops', { replace: true });
  }, [loading, navigate, pickOpen, shops.length]);

  useEffect(() => {
    if (!pickOpen || shops.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      pickerHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pickOpen, shops.length]);

  const active = jobs.filter((j) => statusMeta(j.status).active);
  const firstName = me?.name?.split(' ')[0] ?? 'there';

  function startPrint() {
    const action = resolveNewPrintAction(lastShopSlug(), shops);
    if (action.kind === 'shop') navigate(`/s/${action.slug}`);
    else if (action.kind === 'picker') setPickOpen(true);
    else navigate('/shops');
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

        <button
          className={`cta-print${pickOpen && shops.length > 1 ? ' is-open' : ''}`}
          onClick={startPrint}
          aria-expanded={shops.length > 1 ? pickOpen : undefined}
          aria-controls={shops.length > 1 ? 'home-shop-picker' : undefined}
        >
          <span className="ic">
            <IconPlus />
          </span>
          <span style={{ flex: 1 }}>
            <strong>New print</strong>
            <span>Prepare it now, check in when you arrive</span>
          </span>
          <IconChevron />
        </button>

        {pickOpen && shops.length > 0 && (
          <div
            id="home-shop-picker"
            ref={pickerRef}
            className={`shop-picker${pickOpen ? ' is-open' : ''}`}
            role="region"
            aria-labelledby="home-shop-picker-title"
          >
            <div className="section-head">
              <h2 id="home-shop-picker-title" ref={pickerHeadingRef} tabIndex={-1}>Choose a shop</h2>
            </div>
            {pickOpen && <p className="shop-picker-feedback" role="status">Select where you want to print next.</p>}
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
          </div>
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
                  Scan your shop's QR code, or <Link to="/shops">find a nearby shop</Link> to start a print.
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
