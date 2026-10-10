import { Link } from 'react-router-dom';
import { dueCountdown, formatDay, formatRupees, STATE_CHIP, type FeeOverview } from '../lib/fees.js';

interface Props {
  fees: FeeOverview;
  paying: boolean;
  message: { tone: 'ok' | 'info' | 'error'; text: string } | null;
  onPay: () => void;
  now?: number;
}

/** Platform-fee summary: amount due, due date, status, and the one Pay button. */
export default function FeeCard({ fees, paying, message, onPay, now = Date.now() }: Props) {
  const chip = STATE_CHIP[fees.state];
  const countdown = dueCountdown(fees.nextDueAt, now);
  const canPay = fees.enabled && fees.totalDuePaise > 0;

  return (
    <section className={`fee-card fee-${fees.state}`} aria-labelledby="fee-card-title">
      <div className="fee-card-main">
        <div className="fee-card-head">
          <h2 id="fee-card-title">Platform fees</h2>
          <span className={`stamp ${chip.tone}`} data-testid="fee-chip">{chip.label}</span>
        </div>
        <div className="fee-amount" aria-live="polite">{formatRupees(fees.totalDuePaise)}</div>
        <p className="fee-sub">
          {fees.totalDuePaise === 0 && 'Nothing to pay. Your next weekly statement appears after Monday.'}
          {fees.totalDuePaise > 0 && countdown && <strong>{countdown}</strong>}
          {fees.totalDuePaise > 0 && fees.nextDueAt && <> · pay by {formatDay(fees.nextDueAt)}</>}
          {fees.totalDuePaise > 0 && !countdown && 'This week’s commission is still adding up. It becomes a statement on Monday.'}
        </p>
        {fees.state === 'blocked' && (
          <p className="fee-note">New orders are paused for students. Pay to reopen right away; orders already in your queue continue.</p>
        )}
        {fees.accruedPaise > 0 && fees.statementsDuePaise > 0 && (
          <p className="fee-note">Includes {formatRupees(fees.accruedPaise)} earned since the last statement.</p>
        )}
      </div>
      <div className="fee-card-action">
        {canPay ? (
          <button onClick={onPay} disabled={paying}>{paying ? 'Opening payment…' : `Pay ${formatRupees(fees.totalDuePaise)} now`}</button>
        ) : !fees.enabled ? (
          <p className="dim">Online fee payment is not switched on yet. PrintQs will tell you before the first statement is due.</p>
        ) : null}
        <p className="dim fee-terms">Fees are due {fees.termsDays} days after each weekly statement. Unpaid fees temporarily pause new orders.</p>
      </div>
      {message && <div className={`fee-message ${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>{message.text}</div>}
    </section>
  );
}

export function FeeStatementsTable({ fees }: { fees: FeeOverview }) {
  return (
    <div className="table-shell">
      <table className="fee-table">
        <thead><tr><th>Week</th><th>Orders</th><th>Amount</th><th>Due date</th><th>Status</th></tr></thead>
        <tbody>
          {fees.statements.length === 0 && (
            <tr><td colSpan={5} className="dim">Your first statement appears after a full week of completed prints.</td></tr>
          )}
          {fees.statements.map((s) => (
            <tr key={s.id}>
              <td>{formatDay(s.periodStart)} – {formatDay(s.periodEnd)}</td>
              <td className="mono">{s.ordersCount}</td>
              <td className="mono">{formatRupees(s.amountPaise)}{s.status !== 'paid' && s.paidPaise > 0 && <small className="dim"> ({formatRupees(s.outstandingPaise)} left)</small>}</td>
              <td>{s.dueAt ? formatDay(s.dueAt) : '—'}</td>
              <td><span className={`stamp ${s.status === 'paid' ? 'green' : s.status === 'overdue' ? 'red' : 'yellow'}`}>{s.status === 'paid' ? 'Paid' : s.status === 'overdue' ? 'Overdue' : 'Unpaid'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FeePaymentsTable({ fees }: { fees: FeeOverview }) {
  const rows = fees.payments.filter((p) => p.status === 'paid');
  return (
    <div className="table-shell">
      <table className="fee-table">
        <thead><tr><th>Paid on</th><th>Amount</th><th>Razorpay payment</th><th>Receipt</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="dim">Payments you make will be listed here with a receipt.</td></tr>}
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.paidAt ? new Date(p.paidAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}</td>
              <td className="mono">{formatRupees(p.amountPaise)}</td>
              <td className="mono">{p.providerPaymentId ?? '—'}</td>
              <td><Link to={`/dashboard/earnings/receipt/${p.id}`}>View receipt</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
