import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api, downloadFile, getToken, rupees } from '../../api.js';
import { stampClass, statusMeta, type SpecsLite } from '../../jobStatus.js';
import ShopNav from '../../components/ShopNav.js';
import { shopLoginPath } from '../../lib/locationFlow.js';
import { matchesHistory, specsSummary } from './counterFlow.js';

interface Row {
  id: string;
  status: string;
  specs: SpecsLite;
  pagesPerCopy: number;
  totalPaise: number;
  at: string;
  paymentStatus: 'pending' | 'cash_due' | 'paid' | 'refunding' | 'refunded' | 'failed';
  printer: string | null;
  student: { name: string | null; phoneMasked: string };
  file: string;
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

export default function History() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Row[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');

  const load = useCallback(() => {
    setError('');
    api<{ jobs: Row[] }>('/api/shop/history', { role: 'shop' })
      .then((r) => setJobs(r.jobs))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate(shopLoginPath());
        else setError(err instanceof Error ? err.message : 'Could not load the history. Try again.');
      });
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(shopLoginPath());
      return;
    }
    load();
  }, [navigate, load]);

  const shown = useMemo(() => (jobs ?? []).filter((j) => matchesHistory(j, query)), [jobs, query]);

  return (
    <div className="page wide shop-page history-page">
      <ShopNav />
      <div className="page-heading">
        <div>
          <h1>History</h1>
          <p>Every finished order: who, what, which printer and how much.</p>
        </div>
        <button
          type="button"
          className="secondary small"
          onClick={() => downloadFile('/api/shop/history.csv', 'shop', 'printqs-history.csv').catch(() => setError('Could not download the file. Try again.'))}
        >
          Download CSV
        </button>
      </div>

      <div className="search-field history-search">
        <span aria-hidden>⌕</span>
        <input type="search" aria-label="Find a student, phone or file" placeholder="Find a student, phone or file" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {error && (
        <div className="notice danger" role="alert">
          <div><strong>{error}</strong></div>
          <button type="button" className="secondary" onClick={load}>Try again</button>
        </div>
      )}

      {!jobs && !error ? (
        <div className="skeleton-list" role="status" aria-label="Loading history"><div className="skeleton-card" /><div className="skeleton-card" /></div>
      ) : jobs && jobs.length === 0 ? (
        <div className="empty-state"><strong>No finished orders yet</strong><p>Orders show up here once they are collected or cancelled.</p></div>
      ) : jobs && shown.length === 0 ? (
        <p className="dim">Nothing matches “{query}”.</p>
      ) : (
        <ul className="history-list">
          {shown.map((j) => {
            const m = statusMeta(j.status);
            return (
              <li key={j.id} className="history-row">
                <span className="history-when">{when(j.at)}</span>
                <div className="history-main">
                  <strong>{j.student.name ?? j.student.phoneMasked}</strong>
                  <span className="history-file" title={j.file}>{j.file}</span>
                  <span className="history-specs">{specsSummary(j)}{j.printer ? ` · ${j.printer}` : ''}</span>
                </div>
                <div className="history-side">
                  <span className={stampClass(m.tone)}>{m.label}</span>
                  {j.paymentStatus === 'refunded' && <span className="stamp green">refunded</span>}
                  <span className="num history-amount">{rupees(j.totalPaise)}</span>
                  <button
                    type="button"
                    className="quiet"
                    onClick={() => downloadFile(`/api/shop/jobs/${j.id}/receipt`, 'shop', `printqs-receipt-${j.id.slice(0, 8)}.pdf`).catch(() => setError('Could not download the receipt. Try again.'))}
                  >
                    Receipt
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
