import { describe, expect, it } from 'vitest';
import {
  COUNTER_CODE_LOOKUP_STATUSES,
  isDirectCounterReleaseRecoverable,
} from './release.js';

describe('counter-code queue contract', () => {
  it('keeps a removed or legacy queued paid job discoverable by its stable code', () => {
    expect(COUNTER_CODE_LOOKUP_STATUSES).toContain('awaiting_arrival');
    expect(COUNTER_CODE_LOOKUP_STATUSES).toContain('no_show');
    expect(COUNTER_CODE_LOOKUP_STATUSES).toContain('requeued');
    expect(isDirectCounterReleaseRecoverable('awaiting_arrival')).toBe(true);
    expect(isDirectCounterReleaseRecoverable('no_show')).toBe(true);
    expect(isDirectCounterReleaseRecoverable('requeued')).toBe(true);
  });

  it('does not mistake an in-flight or terminal job for a new counter release', () => {
    expect(isDirectCounterReleaseRecoverable('printing')).toBe(false);
    expect(isDirectCounterReleaseRecoverable('completed')).toBe(false);
    expect(isDirectCounterReleaseRecoverable('cancelled')).toBe(false);
  });
});
