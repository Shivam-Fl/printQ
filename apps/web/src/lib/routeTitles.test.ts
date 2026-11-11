import { describe, expect, it } from 'vitest';
import { titleForPath } from './routeTitles.js';

describe('titleForPath', () => {
  it('titles known routes', () => {
    expect(titleForPath('/shops')).toBe('Find a print shop · PrintQs');
    expect(titleForPath('/dashboard/')).toBe('Counter · PrintQs');
    expect(titleForPath('/dashboard/prices')).toBe('Prices · PrintQs');
    expect(titleForPath('/s/abc')).toContain('Print at this shop');
    expect(titleForPath('/jobs/123')).toContain('Print status');
    expect(titleForPath('/')).toContain('skip the print queue');
    expect(titleForPath('/pc')).toBe('Install PrintQs on your shop computer · PrintQs');
  });
  it('titles unknown routes as not found', () => {
    expect(titleForPath('/nope/nothing')).toBe('Page not found · PrintQs');
  });
});
