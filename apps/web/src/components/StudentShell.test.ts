import { describe, expect, it } from 'vitest';
import { resolveBottomNewPrintPath } from './StudentShell.js';

describe('student bottom navigation', () => {
  it('never opens an unpublished remembered shop from the plus action: Home decides, from live shops only', () => {
    expect(resolveBottomNewPrintPath('old-qa-shop')).toBe('/home?pick=1');
    expect(resolveBottomNewPrintPath(null)).toBe('/home?pick=1');
  });
});
