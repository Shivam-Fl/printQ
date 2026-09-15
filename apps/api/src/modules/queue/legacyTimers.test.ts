import { describe, expect, it } from 'vitest';
import { isLegacyNoShowTimerDue } from './engine.js';

describe('legacy no-show timer compatibility', () => {
  const now = new Date('2026-09-15T12:00:00.000Z').getTime();

  it('does not remove a notified legacy job while a newer OTP window remains open', () => {
    expect(isLegacyNoShowTimerDue(new Date(now + 60_000), now)).toBe(false);
  });

  it('permits only timer work for an absent or expired legacy window', () => {
    expect(isLegacyNoShowTimerDue(null, now)).toBe(true);
    expect(isLegacyNoShowTimerDue(new Date(now - 1), now)).toBe(true);
    expect(isLegacyNoShowTimerDue(new Date(now), now)).toBe(true);
  });
});
