import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getShopRole, getToken } from '../../api.js';
import { formatDay, formatRupees } from '../../lib/fees.js';

interface Receipt {
  receiptNo: string;
  issuer: string;
  shopName: string;
  paidAt: string;
  amountPaise: number;
  providerPaymentId: string;
  periods: { periodStart: string; periodEnd: string; amountPaise: number }[];
  currentWeekPaise: number;
}

/** Printable fee receipt (use the browser's Print / Save as PDF). No student data. */
export default function FeeReceipt() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('shop') || getShopRole() === 'staff') {
      navigate('/dashboard/login');
      return;
    }
    api<{ receipt: Receipt }>(`/api/shop/fees/payments/${encodeURIComponent(id)}/receipt`, { role: 'shop' })
      .then((r) => setReceipt(r.receipt))
      .catch(() => setError('We could not find that receipt.'));
  }, [id, navigate]);

  return (
    <div className="page receipt-page">
      <div className="receipt-actions no-print">
        <Link to="/dashboard/earnings">Back to earnings</Link>
        {receipt && <button onClick={() => window.print()}>Print or save as PDF</button>}
      </div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {receipt && (
        <article className="receipt-sheet">
          <h1>Payment receipt</h1>
          <p className="dim">Receipt {receipt.receiptNo}</p>
          <dl>
            <dt>Issued by</dt><dd>{receipt.issuer}</dd>
            <dt>Paid by</dt><dd>{receipt.shopName}</dd>
            <dt>Date</dt><dd>{new Date(receipt.paidAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
            <dt>Razorpay payment</dt><dd className="mono">{receipt.providerPaymentId}</dd>
            <dt>For</dt>
            <dd>
              PrintQs platform fees
              <ul>
                {receipt.periods.map((p) => (
                  <li key={p.periodStart}>Week {formatDay(p.periodStart)} – {formatDay(p.periodEnd)}: {formatRupees(p.amountPaise)}</li>
                ))}
                {receipt.currentWeekPaise > 0 && <li>Current week (advance): {formatRupees(receipt.currentWeekPaise)}</li>}
              </ul>
            </dd>
          </dl>
          <p className="receipt-total">Amount paid <strong>{formatRupees(receipt.amountPaise)}</strong></p>
        </article>
      )}
    </div>
  );
}
