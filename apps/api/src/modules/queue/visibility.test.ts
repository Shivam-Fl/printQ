import { describe, expect, it } from 'vitest';
import { isCounterCodeAvailable } from './visibility.js';

describe('counter-code visibility', () => {
  it('hides the code before arrival and outside the near-front window', () => {
    expect(isCounterCodeAvailable('awaiting_arrival', null, 5, false)).toBe(false);
    expect(isCounterCodeAvailable('queued', 6, 5, false)).toBe(false);
  });

  it('reveals automatically at the threshold and never hides it again', () => {
    expect(isCounterCodeAvailable('queued', 5, 5, false)).toBe(true);
    expect(isCounterCodeAvailable('queued', 7, 5, true)).toBe(true);
    expect(isCounterCodeAvailable('no_show', null, 5, true)).toBe(true);
    expect(isCounterCodeAvailable('awaiting_arrival', null, 5, true)).toBe(true);
  });

  it('keeps the code available for collection', () => {
    expect(isCounterCodeAvailable('ready_for_pickup', null, 5, false)).toBe(true);
  });
});
