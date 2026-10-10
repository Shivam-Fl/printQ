import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BandPill, StudentBandPanel, countdownFor, type BandJob } from './QueueBand.js';
import QueueSettings, { clampCapacity, graceLabel } from './QueueSettings.js';

const NOW = new Date('2026-10-10T10:00:00Z').getTime();
const base: BandJob = { status: 'queued', position: 1, etaMinutes: 2, band: 'revealed', revealDeadlineAt: null, otpCode: null };
const render = (job: Partial<BandJob>, nowMs = NOW) => renderToStaticMarkup(<StudentBandPanel nowMs={nowMs} job={{ ...base, ...job }} />);

describe('countdown', () => {
  it('formats m:ss and goes urgent at 10 s', () => {
    const at = (s: number) => countdownFor(new Date(NOW + s * 1000).toISOString(), NOW)!;
    expect(at(42).text).toBe('0:42');
    expect(at(42).urgent).toBe(false);
    expect(at(120).text).toBe('2:00');
    expect(at(10).urgent).toBe(true);
    expect(at(0)).toMatchObject({ text: '0:00', expired: true, urgent: true });
    expect(at(-30).seconds).toBe(0);
  });
  it('is null without a deadline', () => {
    expect(countdownFor(null, NOW)).toBeNull();
  });
});

describe('student band panel', () => {
  it('revealed: perforated ticket with the code and a live countdown', () => {
    const html = render({ otpCode: '482913', revealDeadlineAt: new Date(NOW + 42_000).toISOString() });
    expect(html).toContain('class="ticket turn band-ticket"');
    expect(html).toContain('482913');
    expect(html).toContain('Be at the counter in 0:42');
    expect(html).not.toContain('urgent');
  });
  it('revealed: turns urgent near zero', () => {
    const html = render({ otpCode: '482913', revealDeadlineAt: new Date(NOW + 6_000).toISOString() });
    expect(html).toContain('band-countdown urgent');
    expect(html).toContain('Be at the counter in 0:06');
  });
  it('does not make the per-second countdown a live region (screen readers get one static announcement instead)', () => {
    for (const s of [42, 6]) {
      const html = render({ otpCode: '482913', revealDeadlineAt: new Date(NOW + s * 1000).toISOString() });
      expect(html).not.toContain('aria-live="assertive"');
      expect(html).toContain('class="sr-only" role="status"');
      expect(html).not.toMatch(/role="status">[^<]*d:dd/);
    }
  });
  it('revealed without a timer (staff has the order) still shows the code', () => {
    const html = render({ otpCode: '111222' });
    expect(html).toContain('111222');
    expect(html).toContain('Please be at the counter');
  });
  it('arriving: banner + position, never a code', () => {
    const html = render({ band: 'arriving', position: 7, otpCode: null });
    expect(html).toContain('Your turn is coming up — please head to the shop.');
    expect(html).toContain('#7');
    expect(html).not.toContain('otp-band');
  });
  it('waiting: position only', () => {
    const html = render({ band: 'waiting', position: 12 });
    expect(html).toContain('#12');
    expect(html).not.toContain('otp-band');
    expect(html).not.toContain('head to the shop');
  });
});

describe('dashboard band pill', () => {
  it('shows the band and countdown only for revealed students', () => {
    const deadline = new Date(NOW + 30_000).toISOString();
    expect(renderToStaticMarkup(<BandPill band="revealed" deadline={deadline} nowMs={NOW} />)).toContain('0:30');
    expect(renderToStaticMarkup(<BandPill band="arriving" deadline={deadline} nowMs={NOW} />)).not.toContain('0:30');
    expect(renderToStaticMarkup(<BandPill band={null} nowMs={NOW} />)).toBe('');
  });
});

describe('queue settings', () => {
  it('clamps capacity to 1-20', () => {
    expect(clampCapacity(0)).toBe(1);
    expect(clampCapacity(21)).toBe(20);
    expect(clampCapacity(7.4)).toBe(7);
    expect(clampCapacity(Number.NaN)).toBe(1);
  });
  it('offers exactly 30 s / 1 min / 2 min and marks the current one', () => {
    expect([30, 60, 120].map(graceLabel)).toEqual(['30 s', '1 min', '2 min']);
    const html = renderToStaticMarkup(<QueueSettings capacity={5} graceSeconds={60} onChange={() => undefined} />);
    expect(html).toContain('Counter capacity');
    expect(html).toContain('value="5"');
    expect(html.match(/role="radio"/g)).toHaveLength(3);
    expect(html).toMatch(/aria-checked="true"[^>]*>1 min/);
    expect(html).toContain('never un-called');
  });
  it('disables the stepper at the limits', () => {
    expect(renderToStaticMarkup(<QueueSettings capacity={1} graceSeconds={30} onChange={() => undefined} />))
      .toMatch(/aria-label="Decrease counter capacity"[^>]*disabled|disabled[^>]*aria-label="Decrease counter capacity"/);
    expect(renderToStaticMarkup(<QueueSettings capacity={20} graceSeconds={30} onChange={() => undefined} />))
      .toMatch(/aria-label="Increase counter capacity"[^>]*disabled|disabled[^>]*aria-label="Increase counter capacity"/);
  });
});
