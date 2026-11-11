import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, ago, api, getToken, lastShopSlug, rememberShop, rupees } from '../../api.js';
import { nextStepLine, stampClass, statusMeta } from '../../jobStatus.js';
import { nothingCharged } from './jobPayment.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';
import InstallPrompt from '../../components/InstallPrompt.js';
import { ErrorState, LoadingState } from '../../components/ResourceStates.js';
import { useResource } from '../../lib/useResource.js';
import { IconChevron, IconPlus } from '../../components/Icons.js';

interface JobRow {
  id: string;
  status: string;
  totalPaise: number;
  createdAt: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  checkInCount?: number;
  shop: { name: string; slug: string };
  file: { originalName: string };
  /** Present once the list API returns it; used to say "Nothing charged" on cancelled orders. */
  paymentStatus?: string;
}
interface Me {
  name: string | null;
  phone: string;
}

export type NewPrintAction =
  | { kind: 'shop'; slug: string }
  | { kind: 'picker' }
  | { kind: 'directory' };

/**
 * "New print": the shops the student ordered from decide (one → that shop, several → the chooser). A student who
 * has not ordered yet goes to the shop they last opened (say, by scanning its QR), but only while it is published.
 */
export function resolveNewPrintAction(
  rememberedSlug: string | null,
  shops: Array<{ slug: string }>,
  publishedShops: Array<{ slug: string }> = [],
): NewPrintAction {
  const onlyShop = shops[0];
  if (onlyShop && shops.length === 1) return { kind: 'shop', slug: onlyShop.slug };
  if (shops.length > 0) return { kind: 'picker' };
  if (rememberedSlug && publishedShops.some((shop) => shop.slug === rememberedSlug)) return { kind: 'shop', slug: rememberedSlug };
  return { kind: 'directory' };
}

export function filterPublishedHistoryShops<T extends { slug: string }>(
  historyShops: T[],
  publishedShops: Array<{ slug: string }>,
): T[] {
  const published = new Set(publishedShops.map((shop) => shop.slug));
  return historyShops.filter((shop) => published.has(shop.slug));
}

function OrderRow({ job }: { job: JobRow }) {
  const m = statusMeta(job.status);
  return (
    <li>
      <Link to={`/jobs/${job.id}`} className="order-row">
        <span className="order-row-main">
          <strong>{job.file.originalName}</strong>
          {m.active && <span className="order-row-next">{nextStepLine(job)}</span>}
          <span>{m.active ? job.shop.name : `${job.shop.name} · ${ago(job.createdAt)}`}</span>
        </span>
        <span className="order-row-side">
          <span className={stampClass(m.tone)}>{m.label}</span>
          <span className="num">{nothingCharged(job.status, job.paymentStatus) ? 'Nothing charged' : rupees(job.totalPaise)}</span>
        </span>
      </Link>
    </li>
  );
}

export default function Home() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const signedIn = Boolean(getToken('student'));
  const [pickOpen, setPickOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerHeadingRef = useRef<HTMLHeadingElement>(null);

  const home = useResource<{ me: Me; jobs: JobRow[]; publishedShops: Array<{ slug: string }> }>(
    async (signal) => {
      const [m, j, published] = await Promise.all([
        api<{ student: Me }>('/api/auth/student/me', { role: 'student', signal }),
        api<{ jobs: JobRow[] }>('/api/jobs', { role: 'student', signal }),
        api<{ shops: Array<{ slug: string }> }>('/api/public/shops', { signal }),
      ]);
      return { me: m.student, jobs: j.jobs, publishedShops: published.shops };
    },
    [],
    {
      enabled: signedIn,
      validate: (v): v is { me: Me; jobs: JobRow[]; publishedShops: Array<{ slug: string }> } => {
        const d = v as { me?: unknown; jobs?: unknown; publishedShops?: unknown };
        return Boolean(d.me) && Array.isArray(d.jobs) && Array.isArray(d.publishedShops);
      },
    },
  );
  const me = home.data?.me ?? null;
  const jobs = useMemo(() => home.data?.jobs ?? [], [home.data]);
  const publishedShops = useMemo(() => home.data?.publishedShops ?? [], [home.data]);
  const ready = home.status === 'ready';
  const unauthorized = home.status === 'error' && home.error instanceof ApiError && home.error.status === 401;

  useEffect(() => {
    if (!signedIn || unauthorized) navigate('/login', { replace: true });
  }, [signedIn, unauthorized, navigate]);

  // distinct live shops from history, most recent first
  const shops = useMemo(() => {
    const seen = new Map<string, { slug: string; name: string }>();
    for (const j of jobs) if (!seen.has(j.shop.slug)) seen.set(j.shop.slug, j.shop);
    return filterPublishedHistoryShops([...seen.values()], publishedShops);
  }, [jobs, publishedShops]);

  function startPrint() {
    const action = resolveNewPrintAction(lastShopSlug(), shops, publishedShops);
    if (action.kind === 'shop') {
      rememberShop(action.slug);
      navigate(`/s/${action.slug}`);
    } else if (action.kind === 'picker') setPickOpen(true);
    else navigate('/shops');
  }

  // the bottom bar's Print button lands here with ?pick=1: same rule as "New print"
  const wantsPick = params.get('pick') === '1';
  useEffect(() => {
    if (!wantsPick || !ready) return;
    setParams({}, { replace: true });
    startPrint();
  }, [wantsPick, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!pickOpen || shops.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      pickerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      pickerHeadingRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pickOpen, shops.length]);

  const active = jobs.filter((j) => statusMeta(j.status).active);
  const earlier = jobs.filter((j) => !statusMeta(j.status).active);
  const firstName = me?.name?.trim().split(/\s+/)[0] ?? null;

  return (
    <StudentShell>
      <div className="page">
        <Topbar right={<Link to="/profile">Profile</Link>} />
        <div className="hero">
          {ready ? (
            <h1 className="hi">{firstName ? `Hi ${firstName}` : 'Hi'}</h1>
          ) : (
            <span className="skeleton-line wide" aria-hidden />
          )}
        </div>

        <InstallPrompt />

        {home.status === 'error' && !unauthorized && <ErrorState onRetry={home.retry} title="Could not load your prints" />}

        <button
          type="button"
          className={`cta-print${pickOpen && shops.length > 1 ? ' is-open' : ''}`}
          onClick={startPrint}
          disabled={!ready}
          aria-expanded={shops.length > 1 ? pickOpen : undefined}
          aria-controls={shops.length > 1 ? 'home-shop-picker' : undefined}
        >
          <span className="ic">
            <IconPlus />
          </span>
          <span style={{ flex: 1 }}>
            <strong>New print</strong>
            <span>Upload now, pay at the shop</span>
          </span>
          <IconChevron />
        </button>

        {pickOpen && shops.length > 0 && (
          <div id="home-shop-picker" ref={pickerRef} className="shop-picker is-open" role="region" aria-labelledby="home-shop-picker-title">
            <div className="section-head">
              <h2 id="home-shop-picker-title" ref={pickerHeadingRef} tabIndex={-1}>Choose a shop</h2>
              <Link to="/shops">Other shops</Link>
            </div>
            <div className="shops-row">
              {shops.map((s) => (
                <button
                  key={s.slug}
                  type="button"
                  className="shop-chip"
                  onClick={() => {
                    rememberShop(s.slug);
                    navigate(`/s/${s.slug}`);
                  }}
                >
                  <strong>{s.name}</strong>
                </button>
              ))}
            </div>
          </div>
        )}

        {!ready && home.status !== 'error' && (home.status === 'slow' || home.status === 'retrying' ? (
          <LoadingState status={home.status} rows={2} />
        ) : (
          <div className="skeleton-list" role="status" aria-label="Loading your prints">
            <div className="skeleton-card" />
            <div className="skeleton-card" />
          </div>
        ))}

        {active.length > 0 && (
          <section className="home-section" aria-labelledby="home-now">
            <h2 id="home-now">Now</h2>
            <ul className="order-list">{active.map((j) => <OrderRow key={j.id} job={j} />)}</ul>
          </section>
        )}

        {ready && jobs.length === 0 && (
          <div className="empty-state home-empty">
            <strong>No prints yet</strong>
            <p>Scan the QR code at a print shop, or find a shop near you.</p>
            <Link to="/shops" className="button-link" style={{ marginTop: 14 }}>Find a shop</Link>
          </div>
        )}

        {earlier.length > 0 && (
          <section className="home-section" aria-labelledby="home-earlier">
            <div className="section-head">
              <h2 id="home-earlier">Earlier</h2>
              <Link to="/jobs">See all</Link>
            </div>
            <ul className="order-list">{earlier.slice(0, 3).map((j) => <OrderRow key={j.id} job={j} />)}</ul>
          </section>
        )}
      </div>
    </StudentShell>
  );
}
