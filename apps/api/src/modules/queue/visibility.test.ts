import { describe, expect, it } from 'vitest';
import { isCounterCodeAvailable, isNormalCounterRelease } from './visibility.js';

const at = new Date('2026-10-10T10:00:00Z');

describe('counter-code visibility', () => {
  it('hides the code before arrival, outside the revealed band and after absence', () => {
    expect(isCounterCodeAvailable('awaiting_arrival', null)).toBe(false);
    expect(isCounterCodeAvailable('queued', null)).toBe(false); // arriving / waiting
  });

  it('shows the code only for a revealed queued job', () => {
    expect(isCounterCodeAvailable('queued', at)).toBe(true);
    expect(isCounterCodeAvailable('notified', at)).toBe(true);
    // a stale revealedAt can never leak a code outside an active queue state
    expect(isCounterCodeAvailable('awaiting_arrival', at)).toBe(false);
    expect(isCounterCodeAvailable('cancelled', at)).toBe(false);
  });

  it('keeps the code available for collection', () => {
    expect(isCounterCodeAvailable('ready_for_pickup', null)).toBe(true);
  });
});

describe('counter release order', () => {
  it('serves any revealed student normally; others need an override', () => {
    expect(isNormalCounterRelease('queued', 'revealed')).toBe(true);
    expect(isNormalCounterRelease('queued', 'arriving')).toBe(false);
    expect(isNormalCounterRelease('queued', 'waiting')).toBe(false);
  });

  it('requires an override for a student who is absent or not checked in', () => {
    expect(isNormalCounterRelease('awaiting_arrival', null)).toBe(false);
    expect(isNormalCounterRelease('no_show', null)).toBe(false);
  });
});
