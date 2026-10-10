import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import FeeCard, { FeePaymentsTable, FeeStatementsTable } from './FeeCard.js';
import { FeeBannerView } from './FeeBanner.js';
import { bannerCopy, dueCountdown, formatRupees, outcomeMessage, type FeeOverview } from '../lib/fees.js';

const NOW = new Date('2026-10-12T00:00:00Z').getTime();
const DAY = 86_400_000;

const base: FeeOverview = {
  enabled: true,
  provider: 'razorpay',
  termsDays: 7,
  totalDuePaise: 0,
  statementsDuePaise: 0,
  accruedPaise: 0,
  nextDueAt: null,
  state: 'paid_up',
  banner: null,
  statements: [],
  payments: [],
};
const card = (over: Partial<FeeOverview>, message: Parameters<typeof FeeCard>[0]['message'] = null, paying = false) =>
  renderToStaticMarkup(<MemoryRouter><FeeCard fees={{ ...base, ...over }} paying={paying} message={message} onPay={() => undefined} now={NOW} /></MemoryRouter>);

describe('fee formatting', () => {
  it('formats rupees and countdowns', () => {
    expect(formatRupees(12_500)).toBe('₹125');
    expect(formatRupees(12_550)).toBe('₹125.50');
    expect(dueCountdown(new Date(NOW + 3 * DAY - 1000).toISOString(), NOW)).toBe('Due in 3 days');
    expect(dueCountdown(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe('Due within a day');
    expect(dueCountdown(new Date(NOW - 2 * DAY - 5000).toISOString(), NOW)).toBe('Overdue by 2 days');
    expect(dueCountdown(null, NOW)).toBeNull();
  });
});

describe('platform fee card states', () => {
  it('paid up: green chip, no pay button', () => {
    const html = card({});
    expect(html).toContain('Paid up');
    expect(html).toContain('stamp green');
    expect(html).not.toContain('now</button>');
  });

  it('due: yellow chip, exact amount on the pay button and a countdown', () => {
    const html = card({ state: 'due', totalDuePaise: 18_750, statementsDuePaise: 18_750, nextDueAt: new Date(NOW + 4 * DAY).toISOString() });
    expect(html).toContain('Due</span>');
    expect(html).toContain('Pay ₹187.50 now');
    expect(html).toContain('Due in 4 days');
  });

  it('overdue: red chip and overdue wording', () => {
    const html = card({ state: 'overdue', totalDuePaise: 5_000, statementsDuePaise: 5_000, nextDueAt: new Date(NOW - DAY - 1000).toISOString() });
    expect(html).toContain('Overdue</span>');
    expect(html).toContain('stamp red');
    expect(html).toContain('Overdue by 1 day');
  });

  it('blocked: explains the pause without hiding existing queue behaviour', () => {
    const html = card({ state: 'blocked', totalDuePaise: 5_000, statementsDuePaise: 5_000, nextDueAt: new Date(NOW - DAY).toISOString() });
    expect(html).toContain('Blocked</span>');
    expect(html).toContain('New orders are paused');
    expect(html).toContain('already in your queue continue');
  });

  it('disabled provider: no pay button, honest copy', () => {
    const html = card({ enabled: false, provider: null, state: 'due', totalDuePaise: 900, statementsDuePaise: 900 });
    expect(html).not.toContain('now</button>');
    expect(html).toContain('not switched on yet');
  });

  it('disables the button while paying and shows outcome messages', () => {
    const html = card({ state: 'due', totalDuePaise: 900 }, outcomeMessage({ kind: 'pending' }), true);
    expect(html).toContain('disabled');
    expect(html).toContain('Opening payment');
    expect(html).toContain('Do not pay again');
    expect(outcomeMessage({ kind: 'dismissed' })?.text).toContain('Nothing was charged');
    expect(outcomeMessage({ kind: 'failed', message: 'Card declined' })).toEqual({ tone: 'error', text: 'Card declined' });
    expect(outcomeMessage({ kind: 'paid' })?.tone).toBe('ok');
  });
});

describe('statements and payments tables', () => {
  it('lists statements with week range, orders, amount, due date and status', () => {
    const html = renderToStaticMarkup(
      <FeeStatementsTable fees={{
        ...base,
        statements: [{ id: 's1', periodStart: '2026-10-05T00:00:00Z', periodEnd: '2026-10-12T00:00:00Z', ordersCount: 42, amountPaise: 20_000, paidPaise: 5_000, outstandingPaise: 15_000, dueAt: '2026-10-19T00:00:00Z', status: 'unpaid' }],
      }} />,
    );
    expect(html).toContain('42');
    expect(html).toContain('₹200');
    expect(html).toContain('₹150 left');
    expect(html).toContain('Unpaid');
  });

  it('lists only paid payments, each with a receipt link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <FeePaymentsTable fees={{
          ...base,
          payments: [
            { id: 'p1', amountPaise: 1000, status: 'paid', providerPaymentId: 'pay_abc123', paidAt: '2026-10-11T10:00:00Z', createdAt: '2026-10-11T09:59:00Z' },
            { id: 'p2', amountPaise: 2000, status: 'failed', providerPaymentId: null, paidAt: null, createdAt: '2026-10-10T09:59:00Z' },
          ],
        }} />
      </MemoryRouter>,
    );
    expect(html).toContain('pay_abc123');
    expect(html).toContain('/dashboard/earnings/receipt/p1');
    expect(html).not.toContain('p2');
  });
});

describe('global dashboard banner', () => {
  const render = (status: Parameters<typeof FeeBannerView>[0]['status'], isOwner = true, onEarningsPage = false) =>
    renderToStaticMarkup(<MemoryRouter><FeeBannerView status={status} isOwner={isOwner} onEarningsPage={onEarningsPage} /></MemoryRouter>);

  it('is absent when nothing needs attention', () => {
    expect(render({ enabled: true, state: 'due', banner: null, totalDuePaise: 500 })).toBe('');
    expect(render(null)).toBe('');
  });

  it('shows due-soon, overdue and blocked copy with a Pay now link for the owner', () => {
    const soon = render({ enabled: true, state: 'due', banner: 'due_soon', totalDuePaise: 12_500, nextDueAt: '2026-10-14T00:00:00Z' });
    expect(soon).toContain('₹125');
    expect(soon).toContain('Pay now');
    expect(render({ enabled: true, state: 'overdue', banner: 'overdue', totalDuePaise: 12_500 })).toContain('overdue');
    const blocked = render({ enabled: true, state: 'blocked', banner: 'blocked', totalDuePaise: 12_500 });
    expect(blocked).toContain('temporarily paused');
    expect(blocked).toContain('Pay ₹125');
  });

  it('shows staff the blocked notice without amounts or a pay link, and hides due-soon', () => {
    const blocked = render({ enabled: true, state: 'blocked', banner: 'blocked' }, false);
    expect(blocked).toContain('temporarily paused');
    expect(blocked).not.toContain('Pay now');
    expect(render({ enabled: true, state: 'due', banner: 'due_soon' }, false)).toBe('');
  });

  it('does not repeat the Pay now link on the earnings page', () => {
    expect(render({ enabled: true, state: 'blocked', banner: 'blocked', totalDuePaise: 100 }, true, true)).not.toContain('>Pay now<');
    expect(bannerCopy({ banner: null }, true)).toBeNull();
  });
});
