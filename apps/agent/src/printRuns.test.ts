import { describe, expect, it } from 'vitest';
import { printRuns } from './printRuns.js';

const one = { copies: 2, duplex: true, color: false, paperSize: 'A4' };

describe('print runs of a claimed job', () => {
  it('prints a one-setting order once, as before', () => {
    expect(printRuns('j1', one)).toEqual([{ file: '/api/agent/jobs/j1/file', copies: 2, duplex: true, color: false, spoolId: 'j1' }]);
    expect(printRuns('j1', { ...one, parts: null })).toHaveLength(1);
  });

  it('prints each part of a per-file order with its own copies, ink and sides', () => {
    const runs = printRuns('j2', {
      ...one,
      parts: [
        { pages: '1-4', copies: 2, color: false, duplex: true },
        { pages: '5', copies: 1, color: true, duplex: false },
      ],
    });
    expect(runs).toEqual([
      { file: '/api/agent/jobs/j2/file?part=0', copies: 2, duplex: true, color: false, spoolId: 'j2-part1' },
      { file: '/api/agent/jobs/j2/file?part=1', copies: 1, duplex: false, color: true, spoolId: 'j2-part2' },
    ]);
  });
});
