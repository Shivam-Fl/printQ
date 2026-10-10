import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import App from './App.js';

// Leaflet touches `window` on import; the map picker is irrelevant to these static pages.
vi.mock('./components/ShopLocationPicker.js', () => ({ default: () => null }));
import Welcome from './pages/student/Welcome.js';
import * as legal from './lib/legal.js';

function at(path: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('legal and support routes', () => {
  it.each([
    ['/privacy', 'Privacy Policy'],
    ['/terms', 'Terms of Use'],
    ['/refunds', 'Cancellation &amp; Refund Policy'],
    ['/support', 'Support &amp; contact'],
  ])('%s renders its page', (path, heading) => {
    const html = at(path);
    expect(html).toContain(heading);
    expect(html).not.toContain('not in the queue');
    expect(html).toContain('href="/privacy"');
  });

  it('/contact is a redirect to /support, not the 404 page', () => {
    // Static rendering cannot follow <Navigate> (it navigates in an effect), so assert
    // the route is registered as a redirect and does not fall through to NotFound.
    expect(at('/contact')).not.toContain('not in the queue');
    expect(readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')).toMatch(
      /path="\/contact" element=\{<Navigate to="\/support" replace \/>\}/,
    );
  });

  it('policy pages show the last-updated date', () => {
    for (const path of ['/privacy', '/terms', '/refunds']) {
      expect(at(path)).toContain(legal.LEGAL_LAST_UPDATED);
    }
    expect(legal.LEGAL_LAST_UPDATED).toBe('2026-10-10');
  });

  it('unknown routes render NotFound with a way back', () => {
    const html = at('/definitely/not/a/page');
    expect(html).toContain('This page is not in the queue');
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/shops"');
  });

  it('policies describe pay-at-shop and fast document deletion', () => {
    const privacy = at('/privacy');
    expect(privacy).toContain('10 minutes');
    expect(privacy).toContain('24 hours');
    expect(at('/refunds')).toMatch(/does not take your money online/);
    expect(at('/terms')).not.toMatch(/pay online/i);
  });

  it('does not fabricate owner-supplied facts while they are unset', () => {
    const support = at('/support');
    if (legal.SUPPORT_EMAIL === null) {
      expect(support).not.toContain('mailto:');
      expect(support).not.toMatch(/@printqs\.com/);
    }
    if (legal.GRIEVANCE_OFFICER_NAME === null && legal.grievanceEmail() === null) {
      expect(at('/privacy')).toContain('being added');
    }
  });
});

describe('supplied contact details', () => {
  it('render on the support and privacy pages', () => {
    const support = at('/support');
    expect(support).toContain('mailto:admin@printqs.com');
    expect(support).toContain('href="tel:+917822875508"');
    expect(support).toContain('Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs');
    expect(support).toContain('Bhiwandi, Maharashtra, India');
    const privacy = at('/privacy');
    expect(privacy).toContain('Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs');
    expect(at('/terms')).toContain('Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs');
    expect(at('/refunds')).toContain('Shivam Ramkumar Mishra (individual proprietor), trading as PrintQs');
    expect(privacy).toContain('Bhiwandi, Maharashtra');
    expect(legal.GOVERNING_LAW_CITY).toBeNull();
    expect(at('/terms')).not.toContain('courts at');
  });
});

describe('legal constants', () => {
  it('are exported (null until the owner supplies them)', () => {
    for (const key of [
      'LEGAL_ENTITY_NAME',
      'LEGAL_REGISTERED_ADDRESS',
      'SUPPORT_EMAIL',
      'SUPPORT_PHONE',
      'SUPPORT_HOURS',
      'GRIEVANCE_OFFICER_NAME',
      'GRIEVANCE_OFFICER_EMAIL',
      'GOVERNING_LAW_CITY',
    ] as const) {
      expect(key in legal).toBe(true);
    }
    expect(legal.LEGAL_LINKS.map((l) => l.to)).toEqual(['/privacy', '/terms', '/refunds', '/support']);
  });
});

describe('landing footer', () => {
  it('links to every policy page', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Welcome />
      </MemoryRouter>,
    );
    for (const l of legal.LEGAL_LINKS) expect(html).toContain(`href="${l.to}"`);
  });
});
