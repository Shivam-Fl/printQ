import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getShopRole, getToken, rupees } from '../../api.js';
import ShopNav from '../../components/ShopNav.js';

type PayoutStatus = 'requested' | 'processing' | 'paid' | 'failed' | 'cancelled';

interface EarningsData {
  settlementBalancePaise: number;
  availablePaise: number;
  amountDuePaise: number;
  pendingPaise: number;
  lifetimeEarnedPaise: number;
  cashCollectedPaise: number;
  minimumPayoutPaise: number;
  payoutSchedule: 'daily' | 'on_demand';
  payoutProvider: 'mock' | 'razorpay_route';
  balancePaymentProvider: 'mock' | 'razorpay';
  payoutAccountReady: boolean;
  entries: {
    id: string;
    type: 'print_earning' | 'cash_settlement' | 'balance_payment' | 'payout_reserved' | 'payout_released' | 'adjustment';
    amountPaise: number;
    description: string;
    createdAt: string;
    jobId: string | null;
    balancePaymentId: string | null;
  }[];
  payouts: {
    id: string;
    amountPaise: number;
    status: PayoutStatus;
    provider: string;
    createdAt: string;
    paidAt: string | null;
    lastError: string | null;
  }[];
  balancePayments: {
    id: string;
    amountPaise: number;
    status: 'pending' | 'paid' | 'failed';
    provider: string;
    createdAt: string;
    paidAt: string | null;
  }[];
}

const when = (iso: string) => new Date(iso).toLocaleString([], {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const payoutLabel: Record<PayoutStatus, string> = {
  requested: 'Requested',
  processing: 'Processing',
  paid: 'Sent',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export default function Earnings() {
  const navigate = useNavigate();
  const [data, setData] = useState<EarningsData | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const response = await api<{ earnings: EarningsData }>('/api/shop/earnings', { role: 'shop' });
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
    refresh().catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load earnings'));
  }, [navigate, refresh]);

  async function updateSchedule(payoutSchedule: 'daily' | 'on_demand') {
    if (!data) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/api/shop/earnings/settings', {
        method: 'PATCH',
        role: 'shop',
        body: { payoutSchedule },
      });
      setData({ ...data, payoutSchedule });
      setMessage(payoutSchedule === 'daily' ? 'Daily payouts enabled.' : 'Payouts are now on demand.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update payout schedule');
    } finally {
      setBusy(false);
    }
  }

  async function requestPayout() {
    if (!data || !confirm(`Send your full available balance of ${rupees(data.availablePaise)}?`)) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<{ payout: { status: PayoutStatus } }>('/api/shop/earnings/payout', {
        method: 'POST',
        role: 'shop',
      });
      setMessage(response.payout.status === 'paid'
        ? 'Payout sent successfully.'
        : 'Payout requested. The status will update after provider confirmation.');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not request payout');
    } finally {
      setBusy(false);
    }
  }

  async function payAmountDue() {
    if (!data || data.amountDuePaise <= 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const response = await api<{
        balancePayment: { id: string };
        checkout: { mode: 'mock' | 'razorpay'; keyId?: string; orderId?: string; amountPaise?: number };
      }>('/api/shop/earnings/pay-due', { method: 'POST', role: 'shop' });
      if (response.checkout.mode === 'mock') {
        await api('/api/shop/earnings/pay-due/mock-confirm', {
          method: 'POST',
          role: 'shop',
          body: { balancePaymentId: response.balancePayment.id },
        });
        setMessage('Test settlement completed. No real money moved.');
        await refresh();
        return;
      }

      await loadRazorpay();
      const checkout = new window.Razorpay!({
        key: response.checkout.keyId,
        order_id: response.checkout.orderId,
        amount: response.checkout.amountPaise,
        currency: 'INR',
        name: 'PrintQ',
        description: 'Shop cash-order settlement',
        handler: () => {
          setMessage('Payment received. The balance will update after secure confirmation.');
          window.setTimeout(() => void refresh(), 2_500);
        },
      });
      checkout.open();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open settlement payment');
    } finally {
      setBusy(false);
    }
  }

  const canPayout = Boolean(data
    && data.payoutAccountReady
    && data.availablePaise >= data.minimumPayoutPaise);

  return (
    <div className="page wide">
      <ShopNav />
      <div className="page-heading">
        <div>
          <span className="eyebrow-label">Private owner account</span>
          <h1>Earnings &amp; payouts</h1>
          <p>Shop earnings are credited only after a printer confirms a successful print.</p>
        </div>
      </div>

      {error && <div className="error-box" role="alert">{error}</div>}
      {message && <div className="notice earnings-success"><strong>{message}</strong></div>}
      {!data ? <p className="dim">Loading…</p> : (
        <>
          <div className="stat-grid earnings-stats">
            <div className={`stat ${data.amountDuePaise > 0 ? '' : 'accent'}`}><div className="n">{rupees(data.availablePaise)}</div><div className="k">Available to pay out</div></div>
            <div className="stat"><div className="n">{rupees(data.pendingPaise)}</div><div className="k">Paid orders not printed yet</div></div>
            <div className="stat"><div className="n">{rupees(data.lifetimeEarnedPaise)}</div><div className="k">Lifetime shop earnings</div></div>
          </div>

          {data.amountDuePaise > 0 && (
            <section className="notice settlement-due-card">
              <div>
                <span className="eyebrow-label">Cash settlement</span>
                <strong>{rupees(data.amountDuePaise)} due to PrintQ</strong>
                <p>Cash collected at the counter is first offset against online-order earnings. Pay only the remaining net balance.</p>
              </div>
              <button disabled={busy} onClick={() => void payAmountDue()}>{busy ? 'Opening…' : `Pay ${rupees(data.amountDuePaise)}`}</button>
            </section>
          )}

          <div className="earnings-layout">
            <section className="card payout-control">
              <span className="eyebrow-label">Payout preference</span>
              <h2>When should PrintQ send earnings?</h2>
              <div className="field">
                <label htmlFor="payout-schedule">Schedule</label>
                <select
                  id="payout-schedule"
                  value={data.payoutSchedule}
                  disabled={busy}
                  onChange={(event) => void updateSchedule(event.target.value as 'daily' | 'on_demand')}
                >
                  <option value="daily">Daily — send eligible balance automatically</option>
                  <option value="on_demand">On demand — I request each payout</option>
                </select>
              </div>
              <div className="payout-account-row">
                <span className={`stamp ${data.payoutAccountReady ? 'green' : 'yellow'}`}>
                  {data.payoutAccountReady ? 'Payout account ready' : 'Verification required'}
                </span>
                <span className="dim">Minimum {rupees(data.minimumPayoutPaise)}</span>
              </div>
              {!data.payoutAccountReady && <p className="dim">Complete linked-account verification before requesting a transfer.</p>}
              {data.payoutProvider === 'mock' && <p className="simulator-inline">Testing mode: payouts are simulated and no bank transfer occurs.</p>}
              <button className="full-button" disabled={busy || !canPayout} onClick={() => void requestPayout()}>
                {busy ? 'Working…' : `Pay out ${rupees(data.availablePaise)}`}
              </button>
              {!canPayout && data.payoutAccountReady && (
                <p className="dim payout-hint">Available balance must reach {rupees(data.minimumPayoutPaise)}.</p>
              )}
            </section>

            <section className="card">
              <div className="section-head compact"><h2>Recent payouts</h2></div>
              <div className="table-shell flat">
                <table>
                  <thead><tr><th>Requested</th><th>Amount</th><th>Status</th></tr></thead>
                  <tbody>
                    {data.payouts.length === 0 && <tr><td colSpan={3} className="dim">No payouts yet</td></tr>}
                    {data.payouts.map((payout) => (
                      <tr key={payout.id} title={payout.lastError ?? undefined}>
                        <td>{when(payout.createdAt)}</td>
                        <td className="mono">{rupees(payout.amountPaise)}</td>
                        <td><span className={`stamp ${payout.status === 'paid' ? 'green' : payout.status === 'failed' ? 'red' : 'yellow'}`}>{payoutLabel[payout.status]}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div className="section-head"><h2>Account activity</h2></div>
          <div className="table-shell">
            <table>
              <thead><tr><th>Date</th><th>Activity</th><th>Reference</th><th>Amount</th></tr></thead>
              <tbody>
                {data.entries.length === 0 && <tr><td colSpan={4} className="dim">Completed prints will appear here.</td></tr>}
                {data.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{when(entry.createdAt)}</td>
                    <td>{entry.description}</td>
                    <td className="mono">{entry.jobId
                      ? entry.jobId.slice(0, 8).toUpperCase()
                      : entry.balancePaymentId ? 'SETTLEMENT' : 'PAYOUT'}</td>
                    <td className={`mono ledger-amount ${entry.amountPaise >= 0 ? 'positive' : ''}`}>
                      {entry.amountPaise > 0 ? '+' : ''}{rupees(entry.amountPaise)}
                    </td>
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

function loadRazorpay(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://checkout.razorpay.com/v1/checkout.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load payment window'));
    document.body.appendChild(script);
  });
}
