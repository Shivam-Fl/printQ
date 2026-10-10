import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getShopRole, getToken, rupees } from '../../api.js';
import FeeCard, { FeePaymentsTable, FeeStatementsTable } from '../../components/FeeCard.js';
import ShopNav from '../../components/ShopNav.js';
import { enableShopPush } from '../../push.js';
import { getShopSocket } from '../../socket.js';
import { outcomeMessage, payFees, type FeeOverview } from '../../lib/fees.js';

interface CommissionData {
  accountCreditPaise: number;
  entries: {
    id: string;
    type: 'print_commission' | 'refund_credit' | 'manual_credit' | 'statement_settlement';
    amountPaise: number;
    shopFundedDiscountPaise: number;
    description: string;
    createdAt: string;
    jobId: string | null;
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
  const [fees, setFees] = useState<FeeOverview | null>(null);
  const [error, setError] = useState('');
  const [paying, setPaying] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);
  const [pushState, setPushState] = useState<'idle' | 'on' | 'unavailable'>('idle');
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const [commission, feeResponse] = await Promise.all([
      api<{ earnings: CommissionData }>('/api/shop/earnings', { role: 'shop' }),
      api<{ fees: FeeOverview }>('/api/shop/fees', { role: 'shop' }),
    ]);
    setData(commission.earnings);
    setFees(feeResponse.fees);
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
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load your fees'));
    const socket = getShopSocket();
    const onUpdate = () => { void refresh().catch(() => undefined); };
    socket?.on('fee:update', onUpdate);
    return () => {
      socket?.off('fee:update', onUpdate);
      if (polling.current) clearInterval(polling.current);
    };
  }, [navigate, refresh]);

  async function pay() {
    setPaying(true);
    setMessage(null);
    try {
      const outcome = await payFees();
      setMessage(outcomeMessage(outcome));
      await refresh();
      if (outcome.kind === 'pending') {
        // Settlement arrives by webhook: poll briefly, then stop.
        let tries = 0;
        if (polling.current) clearInterval(polling.current);
        polling.current = setInterval(() => {
          tries += 1;
          void refresh().catch(() => undefined);
          if (tries >= 12 && polling.current) clearInterval(polling.current);
        }, 5_000);
      }
    } catch (reason) {
      setMessage({ tone: 'error', text: reason instanceof Error ? reason.message : 'Could not start the payment. Please try again.' });
    } finally {
      setPaying(false);
    }
  }

  return (
    <div className="page wide">
      <ShopNav />
      <div className="page-heading">
        <div>
          <h1>Earnings and fees</h1>
          <p>Students pay you at the counter. PrintQs earns a commission on each completed print, summed into a weekly statement that you pay here.</p>
        </div>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
      {!data || !fees ? <p className="dim">Loading…</p> : (
        <>
          <FeeCard fees={fees} paying={paying} message={message} onPay={pay} />
          {fees.enabled && pushState !== 'on' && (
            <p className="dim fee-push">
              <button
                className="ghost small"
                onClick={async () => setPushState((await enableShopPush()) ? 'on' : 'unavailable')}
              >
                Get fee reminders on this device
              </button>
              {pushState === 'unavailable' && <span> Notifications are not available on this device. We also email you.</span>}
            </p>
          )}

          <div className="section-head"><h2>Weekly statements</h2></div>
          <FeeStatementsTable fees={fees} />

          <div className="section-head"><h2>Payments and receipts</h2></div>
          <FeePaymentsTable fees={fees} />

          <div className="section-head"><h2>Commission activity</h2></div>
          <div className="table-shell">
            <table>
              <thead><tr><th>Date</th><th>Activity</th><th>Print reference</th><th>Commission</th><th>Discount below base</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={5} className="dim">Completed prints will appear here.</td></tr>}
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
