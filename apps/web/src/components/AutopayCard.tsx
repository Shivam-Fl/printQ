import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, rupees } from '../api.js';
import { openMandateCheckout } from '../lib/razorpayCheckout.js';

export type MandateStatus = 'pending' | 'active' | 'revoked' | 'expired' | 'failed' | 'paused';

export interface MandateView {
  enabled: boolean;
  pilotCapPaise: number;
  mandate: null | {
    status: MandateStatus;
    maxAmountPaise: number;
    validUntil: string;
    activatedAt: string | null;
    revokedAt: string | null;
    createdAt: string;
  };
}

export const BADGES: Record<'none' | MandateStatus, { label: string; tone: 'yellow' | 'green' | 'red' | 'blue' }> = {
  none: { label: 'Not set up', tone: 'blue' },
  pending: { label: 'Waiting for confirmation', tone: 'yellow' },
  active: { label: 'Active', tone: 'green' },
  paused: { label: 'Paused', tone: 'yellow' },
  failed: { label: 'Failed', tone: 'red' },
  revoked: { label: 'Cancelled', tone: 'red' },
  expired: { label: 'Expired', tone: 'red' },
};

export interface AutopayCardViewProps {
  view: MandateView;
  accepted: boolean;
  contact: string;
  busy: boolean;
  error: string;
  info: string;
  confirmingCancel: boolean;
  onAccept(value: boolean): void;
  onContact(value: string): void;
  onStart(): void;
  onAskCancel(): void;
  onConfirmCancel(): void;
  onKeep(): void;
}

const CONTACT = /^\+[1-9]\d{7,14}$/;

/** Presentational only, so every state can be rendered in tests. */
export function AutopayCardView(props: AutopayCardViewProps) {
  const { view, accepted, contact, busy, error, info, confirmingCancel } = props;
  const status = view.mandate?.status;
  const badge = BADGES[status ?? 'none'];
  const canSetUp = !status || status === 'failed' || status === 'revoked' || status === 'expired';
  const cap = rupees(view.mandate?.maxAmountPaise ?? view.pilotCapPaise);
  return (
    <section className="notice autopay-card" aria-labelledby="autopay-title">
      <div className="autopay-body">
        <div className="autopay-head">
          <div>
            <span className="eyebrow-label">Test mode only</span>
            <strong id="autopay-title">Weekly commission AutoPay</strong>
          </div>
          <span className={`stamp ${badge.tone}`} data-testid="autopay-badge">{badge.label}</span>
        </div>
        <ul className="autopay-points">
          <li>Once a week, PrintQs debits only the commission you owe for completed prints, through UPI AutoPay.</li>
          <li>Each debit is at most {cap}. The amount changes with your prints; you are never charged more than the statement.</li>
          <li>You get a notice at least 48 hours before every debit, and you can cancel any time from here.</li>
        </ul>
        {status === 'pending' && <p className="autopay-note" role="status">Finish the approval in your UPI app. We show Active only after Razorpay confirms it, which can take a minute.</p>}
        {status === 'failed' && <p className="autopay-note">The approval was not completed. Nothing was set up and nothing was debited. You can try again.</p>}
        {status === 'active' && <p className="autopay-note">AutoPay is on until {new Date(view.mandate!.validUntil).toLocaleDateString()}.</p>}
        {error && <div className="error-box" role="alert">{error}</div>}
        {info && <p className="autopay-note" role="status">{info}</p>}

        {canSetUp && (
          <div className="autopay-form">
            <label className="field-label" htmlFor="autopay-contact">Your mobile number linked to UPI</label>
            <input
              id="autopay-contact" type="tel" inputMode="tel" autoComplete="tel" placeholder="+919876543210"
              value={contact} onChange={(e) => props.onContact(e.target.value)}
            />
            <label className="autopay-terms">
              <input type="checkbox" checked={accepted} onChange={(e) => props.onAccept(e.target.checked)} />
              <span>I agree that PrintQs may debit my weekly commission up to {cap} per debit, and that I can cancel AutoPay at any time.</span>
            </label>
            <button type="button" disabled={busy || !accepted || !CONTACT.test(contact)} onClick={props.onStart}>
              {busy ? 'Opening…' : 'Set up AutoPay'}
            </button>
          </div>
        )}

        {(status === 'active' || status === 'paused' || status === 'pending') && !confirmingCancel && (
          <button type="button" className="ghost small" disabled={busy} onClick={props.onAskCancel}>Cancel AutoPay</button>
        )}
        {confirmingCancel && (
          <div className="autopay-confirm" role="alertdialog" aria-label="Confirm cancelling AutoPay">
            <p>Cancel weekly AutoPay? Your commission will then need to be settled another way.</p>
            <div className="autopay-actions">
              <button type="button" className="danger small" disabled={busy} onClick={props.onConfirmCancel}>{busy ? 'Cancelling…' : 'Yes, cancel AutoPay'}</button>
              <button type="button" className="ghost small" disabled={busy} onClick={props.onKeep}>Keep it</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

const POLL_MS = 4_000;
const POLL_LIMIT = 30;

/** Hidden entirely unless the server says collection is in TEST mode. */
export default function AutopayCard() {
  const [view, setView] = useState<MandateView | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [contact, setContact] = useState('+91');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const polls = useRef(0);

  const refresh = useCallback(async () => {
    const next = await api<MandateView>('/api/shop/collection-mandate', { role: 'shop' });
    setView(next);
    return next;
  }, []);

  useEffect(() => { refresh().catch(() => setView(null)); }, [refresh]);

  // While the mandate awaits the signed webhook, poll the status.
  const waiting = view?.mandate?.status === 'pending';
  useEffect(() => {
    if (!waiting) { polls.current = 0; return; }
    const timer = setInterval(() => {
      if (++polls.current > POLL_LIMIT) { clearInterval(timer); return; }
      refresh().catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, refresh]);

  if (!view?.enabled) return null;

  const fail = (reason: unknown, fallback: string) =>
    setError(reason instanceof ApiError || reason instanceof Error ? (reason.message || fallback) : fallback);

  const start = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      const { checkout } = await api<{ checkout: { keyId: string; orderId: string; customerId: string } }>(
        '/api/shop/collection-mandate',
        { method: 'POST', role: 'shop', body: { acceptTerms: true, contact: contact.trim() } },
      );
      await refresh();
      const result = await openMandateCheckout(checkout);
      if (result === 'dismissed') setInfo('Checkout was closed. You can reopen it by pressing Set up AutoPay again.');
      if (result === 'failed') setError('The UPI approval did not go through. Please try again.');
      polls.current = 0;
      await refresh();
    } catch (reason) {
      fail(reason, 'Could not start AutoPay setup');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true); setError(''); setInfo('');
    try {
      await api('/api/shop/collection-mandate/cancel', { method: 'POST', role: 'shop' });
      setConfirmingCancel(false);
      await refresh();
    } catch (reason) {
      fail(reason, 'Could not cancel AutoPay');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AutopayCardView
      view={view} accepted={accepted} contact={contact} busy={busy} error={error} info={info}
      confirmingCancel={confirmingCancel}
      onAccept={setAccepted} onContact={setContact} onStart={start}
      onAskCancel={() => setConfirmingCancel(true)} onConfirmCancel={cancel} onKeep={() => setConfirmingCancel(false)}
    />
  );
}
