import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AutopayCardView, BADGES, type AutopayCardViewProps, type MandateView } from './AutopayCard.js';

const base = (mandate: MandateView['mandate'], over: Partial<AutopayCardViewProps> = {}): AutopayCardViewProps => ({
  view: { enabled: true, pilotCapPaise: 1_500_000, mandate },
  accepted: false, contact: '+919876543210', busy: false, error: '', info: '', confirmingCancel: false,
  onAccept: vi.fn(), onContact: vi.fn(), onStart: vi.fn(), onAskCancel: vi.fn(), onConfirmCancel: vi.fn(), onKeep: vi.fn(),
  ...over,
});
const m = (status: NonNullable<MandateView['mandate']>['status']): MandateView['mandate'] => ({
  status, maxAmountPaise: 1_500_000, validUntil: '2027-10-10T00:00:00.000Z', activatedAt: null, revokedAt: null, createdAt: '2026-10-10T00:00:00.000Z',
});
const html = (p: AutopayCardViewProps) => renderToStaticMarkup(<AutopayCardView {...p} />);

describe('AutoPay card states', () => {
  it('not set up: plain-language terms, cap, checkbox and a disabled setup button until accepted', () => {
    const out = html(base(null));
    expect(out).toContain('Not set up');
    expect(out).toContain('at most ₹15000.00');
    expect(out).toContain('at least 48 hours before every debit');
    expect(out).toContain('cancel any time');
    expect(out).toContain('type="checkbox"');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Set up AutoPay/);
    expect(html(base(null, { accepted: true }))).not.toMatch(/<button[^>]*disabled=""[^>]*>Set up AutoPay/);
  });

  it('requires a valid contact number even when terms are accepted', () => {
    expect(html(base(null, { accepted: true, contact: '98765' }))).toMatch(/<button[^>]*disabled=""[^>]*>Set up AutoPay/);
  });

  it('pending shows waiting-for-confirmation, never Active, and offers cancel', () => {
    const out = html(base(m('pending')));
    expect(out).toContain('Waiting for confirmation');
    expect(out).not.toContain('>Active<');
    expect(out).toContain('Cancel AutoPay');
    expect(out).not.toContain('Set up AutoPay');
  });

  it('active shows the badge and cancel, with no setup form', () => {
    const out = html(base(m('active')));
    expect(out).toContain('>Active<');
    expect(out).toContain('Cancel AutoPay');
    expect(out).not.toContain('type="checkbox"');
  });

  it('failed and cancelled allow setting up again with a clear message', () => {
    const failed = html(base(m('failed')));
    expect(failed).toContain('Failed');
    expect(failed).toContain('Nothing was set up and nothing was debited');
    expect(failed).toContain('Set up AutoPay');
    const cancelled = html(base(m('revoked')));
    expect(cancelled).toContain('Cancelled');
    expect(cancelled).toContain('Set up AutoPay');
  });

  it('shows a cancel confirmation dialog before cancelling', () => {
    const out = html(base(m('active'), { confirmingCancel: true }));
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain('Yes, cancel AutoPay');
    expect(out).not.toContain('>Cancel AutoPay<');
  });

  it('renders errors accessibly', () => {
    expect(html(base(null, { error: 'Could not start AutoPay setup' }))).toContain('role="alert"');
  });

  it('has a badge for every status', () => {
    expect(Object.keys(BADGES).sort()).toEqual(['active', 'expired', 'failed', 'none', 'paused', 'pending', 'revoked']);
  });
});
