import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getShopRole, getToken, rupees } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';

interface CommissionData {
  amountDuePaise: number;
  accountCreditPaise: number;
  collectionCadence: 'weekly';
  collectionStatus: 'not_configured' | 'test_ready' | 'active' | 'paused';
  entries: {
    id: string;
    type: 'print_commission' | 'refund_credit' | 'manual_credit' | 'statement_settlement';
    amountPaise: number;
    shopFundedDiscountPaise: number;
    description: string;
    createdAt: string;
    jobId: string | null;
  }[];
  statements: {
    id: string;
    periodStart: string;
    periodEnd: string;
    grossCommissionPaise: number;
    creditPaise: number;
    amountDuePaise: number;
    status: 'draft' | 'frozen' | 'notice_sent' | 'debit_pending' | 'settled' | 'failed' | 'paused';
    frozenAt: string | null;
    preDebitNoticeSentAt: string | null;
    debitNotBefore: string | null;
  }[];
}

const when = (iso: string) => new Date(iso).toLocaleString([], {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export default function Earnings() {
  const navigate = useNavigate();
  const [data, setData] = useState<CommissionData | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const response = await api<{ earnings: CommissionData }>('/api/shop/earnings', { role: 'shop' });
    setData(response.earnings);
  }, []);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    if (getShopRole() === 'staff') {
      navigate('/dashboard', { replace: true });
      return;
    }
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load commission account'));
  }, [navigate, refresh]);

  return (
    <div className="page wide">
      <ShopNav />
      <div className="page-heading">
        <div>
          <span className="eyebrow-label">Private owner account</span>
          <h1>PrintQs commission</h1>
          <p>The shop keeps the student’s full cash or merchant-UPI payment. PrintQs posts one commission entry only after verified physical print completion.</p>
        </div>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
      {!data ? <p className="dim">Loading…</p> : (
        <>
          <div className="stat-grid earnings-stats">
            <div className={`stat ${data.amountDuePaise > 0 ? '' : 'accent'}`}>
              <div className="n">{rupees(data.amountDuePaise)}</div><div className="k">Current commission due</div>
            </div>
            <div className="stat">
              <div className="n">{rupees(data.accountCreditPaise)}</div><div className="k">Documented account credit</div>
            </div>
            <div className="stat">
              <div className="n">Weekly</div><div className="k">Collection cadence</div>
            </div>
          </div>

          <section className="notice settlement-due-card">
            <div>
              <span className="eyebrow-label">Weekly collection</span>
              <strong>Mandate setup is not active yet</strong>
              <p>Before any debit, PrintQs will freeze a weekly statement and issue the required 24-hour pre-debit notice. A Razorpay TEST mandate and signed webhook reconciliation must pass before production collection can be enabled.</p>
            </div>
            <span className="stamp yellow">No debit will be attempted</span>
          </section>

          <div className="section-head"><h2>Weekly statements</h2></div>
          <div className="table-shell">
            <table>
              <thead><tr><th>Period</th><th>Commission</th><th>Credits</th><th>Statement total</th><th>Status</th></tr></thead>
              <tbody>
                {data.statements.length === 0 && <tr><td colSpan={5} className="dim">The first statement is frozen only after completed-print entries exist.</td></tr>}
                {data.statements.map((statement) => (
                  <tr key={statement.id}>
                    <td>{new Date(statement.periodStart).toLocaleDateString()} – {new Date(statement.periodEnd).toLocaleDateString()}</td>
                    <td className="mono">{rupees(statement.grossCommissionPaise)}</td>
                    <td className="mono">{rupees(statement.creditPaise)}</td>
                    <td className="mono">{rupees(statement.amountDuePaise)}</td>
                    <td><span className={`stamp ${statement.status === 'settled' ? 'green' : statement.status === 'failed' || statement.status === 'paused' ? 'red' : 'yellow'}`}>{statement.status.replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-head"><h2>Immutable account activity</h2></div>
          <div className="table-shell">
            <table>
              <thead><tr><th>Date</th><th>Activity</th><th>Print reference</th><th>Commission</th><th>Discount below base</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={5} className="dim">Verified completed prints will appear here.</td></tr>}
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{when(entry.createdAt)}</td>
                    <td>{entry.description}</td>
                    <td className="mono">{entry.jobId ? entry.jobId.slice(0, 8).toUpperCase() : '—'}</td>
                    <td className={`mono ledger-amount ${entry.amountPaise > 0 ? 'positive' : ''}`}>
                      {entry.amountPaise > 0 ? '+' : ''}{rupees(entry.amountPaise)}
                    </td>
                    <td className="mono">{entry.shopFundedDiscountPaise > 0 ? rupees(entry.shopFundedDiscountPaise) : '—'}</td>
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
