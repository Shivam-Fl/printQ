import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, downloadFile, getToken, rupees } from '../../api.js';
import { specsText, statusMeta, type SpecsLite } from '../../jobStatus.js';
import ShopNav from '../../components/ShopNav.js';

interface Row {
  id: string;
  status: string;
  specs: SpecsLite;
  pagesPerCopy: number;
  totalPaise: number;
  at: string;
  paymentStatus: 'pending' | 'paid' | 'refunded' | 'failed';
  printer: string | null;
  student: { name: string | null; phoneMasked: string };
  file: string;
}

export default function History() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<Row[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ jobs: Row[] }>('/api/shop/history', { role: 'shop' })
      .then((r) => setJobs(r.jobs))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));
  }, [navigate]);

  return (
    <div className="page wide">
      <ShopNav />
      <div className="row between">
        <h1>History</h1>
        <button
          className="ghost small"
          onClick={() => downloadFile('/api/shop/history.csv', 'shop', 'printq-history.csv').catch(() => setError('Could not download CSV'))}
        >
          Download CSV
        </button>
      </div>
      <p className="dim">Every finished job and which printer it went to.</p>
      {error && <p className="error">{error}</p>}
      <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
        <table>
          <thead>
            <tr><th>When</th><th>Student</th><th>File</th><th>Specs</th><th>Printer</th><th>Status</th><th>Amount</th><th></th></tr>
          </thead>
          <tbody>
            {jobs && jobs.length === 0 && <tr><td colSpan={8} className="dim">No finished jobs yet</td></tr>}
            {jobs?.map((j) => {
              const m = statusMeta(j.status);
              return (
                <tr key={j.id}>
                  <td className="dim mono">{new Date(j.at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td>{j.student.name ?? j.student.phoneMasked}</td>
                  <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.file}</td>
                  <td>{specsText(j.specs, j.pagesPerCopy)}</td>
                  <td>{j.printer ?? '—'}</td>
                  <td>
                    <span className={`stamp ${m.tone}`}>{m.label}</span>
                    {j.paymentStatus === 'refunded' && <span className="stamp green" style={{ marginLeft: 6 }}>refunded</span>}
                  </td>
                  <td className="mono">{rupees(j.totalPaise)}</td>
                  <td>
                    <button
                      className="ghost small"
                      onClick={() =>
                        downloadFile(`/api/shop/jobs/${j.id}/receipt`, 'shop', `printq-receipt-${j.id.slice(0, 8)}.pdf`).catch(
                          () => setError('Could not download receipt'),
                        )
                      }
                    >
                      Receipt
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
