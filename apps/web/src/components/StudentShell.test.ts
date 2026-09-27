import { describe, expect, it } from 'vitest';
import { resolveBottomNewPrintPath } from './StudentShell.js';

describe('student bottom navigation', () => {
  it('never opens an unpublished remembered shop from the plus action', () => {
    expect(resolveBottomNewPrintPath('old-qa-shop')).toBe('/shops');
    expect(resolveBottomNewPrintPath(null)).toBe('/shops');
  });
});
