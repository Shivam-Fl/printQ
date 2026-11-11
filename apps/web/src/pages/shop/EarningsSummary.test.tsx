import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import EarningsSummary, { type ShopStats } from './EarningsSummary.js';

const stats: ShopStats = {
  totalRevenuePaise: 600,
  totalPaidJobs: 1,
  completedJobs: 1,
  pagesPrinted30d: 3,
  todayRevenuePaise: 600,
  todayJobs: 1,
  perPrinter: [{ label: 'Counter laser', jobs: 1, pages: 3 }],
  last7Days: [{ day: '2026-11-11', revenuePaise: 600 }],
};

describe('earnings summary', () => {
  it('shows placeholders while loading', () => {
    expect(renderToStaticMarkup(<EarningsSummary stats={undefined} />)).toContain('skeleton-card');
  });
  it('disappears when the summary could not load, instead of loading forever', () => {
    expect(renderToStaticMarkup(<EarningsSummary stats={null} />)).toBe('');
  });
  it('shows today in the singular for one print', () => {
    const html = renderToStaticMarkup(<EarningsSummary stats={stats} />);
    expect(html).toContain('You earned today · 1 print<');
    expect(html).not.toContain('skeleton-card');
  });
});
