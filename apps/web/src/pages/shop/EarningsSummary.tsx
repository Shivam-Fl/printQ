import { rupees } from '../../api.js';

/** GET /api/shop/stats: earnings are the shop's own price (shopBasePaise), after the PrintQs fee. */
export interface ShopStats {
  totalRevenuePaise: number;
  totalPaidJobs: number;
  completedJobs: number;
  pagesPrinted30d: number;
  todayRevenuePaise: number;
  todayJobs: number;
  perPrinter: { label: string; jobs: number; pages: number }[];
  last7Days: { day: string; revenuePaise: number }[];
}

/** Today, all time and the last 7 days, at the top of Earnings (this used to be a separate Insights page). */
export default function EarningsSummary({ stats }: { stats: ShopStats | null }) {
  if (!stats) {
    return <div className="stat-grid" aria-hidden><div className="skeleton-card" /><div className="skeleton-card" /><div className="skeleton-card" /></div>;
  }
  const maxRev = Math.max(1, ...stats.last7Days.map((d) => d.revenuePaise));
  return (
    <section className="earnings-summary" aria-label="Earnings summary">
      <div className="stat-grid">
        <div className="stat accent">
          <div className="n num">{rupees(stats.todayRevenuePaise)}</div>
          <div className="k">You earned today · {stats.todayJobs} print{stats.todayJobs === 1 ? '' : 's'}</div>
        </div>
        <div className="stat">
          <div className="n num">{rupees(stats.totalRevenuePaise)}</div>
          <div className="k">All time · {stats.completedJobs} print{stats.completedJobs === 1 ? '' : 's'} collected</div>
        </div>
        <div className="stat">
          <div className="n num">{stats.pagesPrinted30d.toLocaleString()}</div>
          <div className="k">Pages printed in 30 days</div>
        </div>
      </div>
      <div className="card earnings-week">
        <h2>Last 7 days</h2>
        <div className="bars" role="img" aria-label={`Earnings for the last 7 days: ${stats.last7Days.map((d) => `${new Date(d.day).toLocaleDateString([], { weekday: 'long', timeZone: 'UTC' })} ${rupees(d.revenuePaise)}`).join(', ')}`}>
          {stats.last7Days.map((d) => (
            <div className="bar" key={d.day}>
              <div className="fill" style={{ height: `${(d.revenuePaise / maxRev) * 100}%` }} title={rupees(d.revenuePaise)} />
              <span className="lbl">{new Date(d.day).toLocaleDateString([], { weekday: 'short', timeZone: 'UTC' })}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
