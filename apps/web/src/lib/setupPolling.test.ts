import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETUP_POLL_MS, shouldPollSetup, startSetupPolling } from './setupPolling.js';

describe('shouldPollSetup', () => {
  it('polls only when loaded and not ready', () => {
    expect(shouldPollSetup(null)).toBe(false);
    expect(shouldPollSetup({ ready: false })).toBe(true);
    expect(shouldPollSetup({ ready: true })).toBe(false);
  });
});

describe('startSetupPolling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(hidden = false) {
    const win = new EventTarget();
    const doc = new EventTarget();
    const poll = vi.fn();
    const state = { hidden };
    const stop = startSetupPolling({ poll, isHidden: () => state.hidden, win, doc });
    return { win, doc, poll, state, stop };
  }

  it('polls on the interval', () => {
    const { poll } = setup();
    vi.advanceTimersByTime(SETUP_POLL_MS * 2);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('polls on window focus and when the tab becomes visible', () => {
    const { poll, win, doc } = setup();
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the tab is hidden', () => {
    const { poll, win, doc } = setup(true);
    vi.advanceTimersByTime(SETUP_POLL_MS * 3);
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(poll).not.toHaveBeenCalled();
  });

  it('stops everything on stop (ready or unmount)', () => {
    const { poll, win, doc, stop } = setup();
    stop();
    vi.advanceTimersByTime(SETUP_POLL_MS * 3);
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(poll).not.toHaveBeenCalled();
  });
});
