import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, rupees } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';

interface Stats {
  totalRevenuePaise: number;
  totalPaidJobs: number;
  completedJobs: number;
  pagesPrinted30d: number;
  todayRevenuePaise: number;
  todayJobs: number;
  perPrinter: { label: string; jobs: number; pages: number }[];
  last7Days: { day: string; revenuePaise: number }[];
}

export default function Insights() {
  const navigate = useNavigate();
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ stats: Stats }>('/api/shop/stats', { role: 'shop' })
      .then((r) => setStats(r.stats))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [navigate]);

  const maxRev = stats ? Math.max(1, ...stats.last7Days.map((d) => d.revenuePaise)) : 1;

  return (
    <div className="page wide">
      <ShopNav />
      <h1>Insights</h1>
      {error && <p className="error">{error}</p>}
      {!stats ? (
        <p className="dim">Loading…</p>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat accent">
              <div className="n">{rupees(stats.todayRevenuePaise)}</div>
              <div className="k">Today's revenue</div>
            </div>
            <div className="stat">
              <div className="n">{stats.todayJobs}</div>
              <div className="k">Prints today</div>
            </div>
            <div className="stat">
              <div className="n">{rupees(stats.totalRevenuePaise)}</div>
              <div className="k">All-time revenue</div>
            </div>
            <div className="stat">
              <div className="n">{stats.completedJobs}</div>
              <div className="k">Prints completed</div>
            </div>
            <div className="stat">
              <div className="n">{stats.pagesPrinted30d.toLocaleString()}</div>
              <div className="k">Pages printed (30d)</div>
            </div>
          </div>

          <div className="section-head"><h2>Revenue · last 7 days</h2></div>
          <div className="card">
            <div className="bars">
              {stats.last7Days.map((d) => (
                <div className="bar" key={d.day}>
                  <div className="fill" style={{ height: `${(d.revenuePaise / maxRev) * 100}%` }} title={rupees(d.revenuePaise)} />
                  <span className="lbl">{new Date(d.day).toLocaleDateString([], { weekday: 'short' })}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="section-head"><h2>By printer (last 30 days)</h2></div>
          <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
            <table>
              <thead><tr><th>Printer</th><th>Jobs</th><th>Pages</th></tr></thead>
              <tbody>
                {stats.perPrinter.length === 0 && <tr><td colSpan={3} className="dim">No completed prints yet</td></tr>}
                {stats.perPrinter.map((p) => (
                  <tr key={p.label}>
                    <td>{p.label}</td>
                    <td className="mono">{p.jobs}</td>
                    <td className="mono">{p.pages.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
