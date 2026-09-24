import { describe, expect, it } from 'vitest';
import {
  TERMINAL_JOB_DELETE_DELAY_MS,
  VERIFIED_PRINT_DELETE_DELAY_MS,
  fileRetentionDeadline,
  terminalJobDeletionDeadline,
  verifiedPrintDeletionDeadline,
} from './fileRetention.js';

describe('strict file-retention deadlines', () => {
  const eventTime = Date.UTC(2026, 8, 16, 10, 0, 0);

  it('sets verified-print deletion exactly ten minutes after physical confirmation', () => {
    expect(verifiedPrintDeletionDeadline(eventTime).getTime() - eventTime).toBe(VERIFIED_PRINT_DELETE_DELAY_MS);
    expect(VERIFIED_PRINT_DELETE_DELAY_MS).toBe(10 * 60_000);
  });

  it('sets cancelled and expired content deletion within the same ten-minute limit', () => {
    expect(terminalJobDeletionDeadline(eventTime).getTime() - eventTime).toBe(TERMINAL_JOB_DELETE_DELAY_MS);
    expect(TERMINAL_JOB_DELETE_DELAY_MS).toBe(10 * 60_000);
  });

  it('keeps unprinted uploads below the independent 24-hour hard maximum', () => {
    expect(fileRetentionDeadline(eventTime).getTime() - eventTime).toBeLessThanOrEqual(24 * 60 * 60_000);
  });
});
