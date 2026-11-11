import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getShopRole, getToken, rupees } from '../../api.js';
import FeeCard, { FeePaymentsTable, FeeStatementsTable } from '../../components/FeeCard.js';
import ShopNav from '../../components/ShopNav.js';
import EarningsSummary, { type ShopStats } from './EarningsSummary.js';
import { enableShopPush } from '../../push.js';
import { getShopSocket } from '../../socket.js';
import { outcomeMessage, payFees, type FeeOverview } from '../../lib/fees.js';
import { shopLoginPath } from '../../lib/locationFlow.js';

interface CommissionData {
  /** Open balance the shop owes PrintQs (the fee part of what students paid at the counter). */
  amountDuePaise: number;
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

/** Plain words for the ledger: "receivable" is PrintQs's view, not the shop's. */
function activityText(entry: CommissionData['entries'][number]): string {
  if (entry.type !== 'print_commission') return entry.description;
  return entry.shopFundedDiscountPaise > 0
    ? 'Completed print (a coupon took it below your price)'
    : 'PrintQs fee on a completed print';
}

/** Owed amounts are plain; credits and payments that reduce what you owe show a minus. */
const dueText = (paise: number) => (paise < 0 ? `−${rupees(-paise)}` : rupees(paise));

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
  const [stats, setStats] = useState<ShopStats | null | undefined>(undefined);
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
      navigate(shopLoginPath());
      return;
    }
    if (getShopRole() === 'staff') {
      navigate('/dashboard', { replace: true });
      return;
    }
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load your earnings. Try again.'));
    // the summary is a bonus: if it fails it disappears (null) instead of loading forever
    api<{ stats: ShopStats }>('/api/shop/stats', { role: 'shop' }).then((r) => setStats(r.stats)).catch(() => setStats(null));
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
    <div className="page wide shop-page earnings-page">
      <ShopNav />
      <div className="page-heading">
        <div>
          <h1>Earnings</h1>
          <p>Students pay you at the counter. You keep your price; the PrintQs fee on each completed print is what you owe PrintQs.</p>
        </div>
      </div>
      <EarningsSummary stats={stats} />

      {error && <div className="error-box" role="alert">{error}</div>}
      {!data || !fees ? <p className="dim">Loading…</p> : (
        <>
          {fees.enabled && <FeeCard fees={fees} paying={paying} message={message} onPay={pay} />}
          {!fees.enabled && (
            <section className={`fee-card ${data.amountDuePaise > 0 ? 'fee-due' : ''}`} aria-labelledby="due-title">
              <div>
                <h2 id="due-title" style={{ margin: 0, fontSize: '1.05rem' }}>Due to PrintQs</h2>
                <div className="fee-amount">{rupees(data.amountDuePaise)}</div>
                <p className="fee-sub">
                  {data.amountDuePaise > 0
                    ? 'This is money you owe PrintQs: the fee part of what students paid you at the counter.'
                    : 'Nothing due right now.'}
                </p>
                {data.accountCreditPaise > 0 && <p className="fee-note">You have {rupees(data.accountCreditPaise)} credit with PrintQs.</p>}
              </div>
              <div className="fee-card-action">
                <p className="dim fee-terms">Online fee payment is not switched on yet. PrintQs will tell you before the first bill is due.</p>
              </div>
            </section>
          )}
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

          {fees.enabled && (
            <>
              <div className="section-head"><h2>Weekly statements</h2></div>
              <FeeStatementsTable fees={fees} />

              <div className="section-head"><h2>Payments and receipts</h2></div>
              <FeePaymentsTable fees={fees} />
            </>
          )}

          {stats && stats.perPrinter.length > 0 && (
            <details className="disclosure earnings-printers">
              <summary>By printer, last 30 days</summary>
              <ul className="staff-list">
                {stats.perPrinter.map((p) => (
                  <li key={p.label}><strong>{p.label}</strong><span className="dim">{p.jobs} prints · {p.pages.toLocaleString()} pages</span></li>
                ))}
              </ul>
            </details>
          )}

          <div className="section-head"><h2 id="fee-activity">PrintQs fee per print</h2></div>
          <div className="table-shell" tabIndex={0} role="region" aria-labelledby="fee-activity">
            <table>
              <thead><tr><th>Date</th><th>What</th><th>Print</th><th>Due to PrintQs</th><th>Coupon below your price</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={5} className="dim">Completed prints will appear here.</td></tr>}
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{when(entry.createdAt)}</td>
                    <td>{activityText(entry)}</td>
                    <td className="mono">{entry.jobId ? entry.jobId.slice(0, 8).toUpperCase() : '—'}</td>
                    <td className={`mono ledger-amount ${entry.amountPaise < 0 ? 'positive' : ''}`}>
                      {dueText(entry.amountPaise)}
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
