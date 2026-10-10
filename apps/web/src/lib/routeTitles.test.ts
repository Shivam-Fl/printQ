import { describe, expect, it } from 'vitest';
import { titleForPath } from './routeTitles.js';

describe('titleForPath', () => {
  it('titles known routes', () => {
    expect(titleForPath('/shops')).toBe('Find a print shop · PrintQs');
    expect(titleForPath('/dashboard/')).toBe('Shop queue · PrintQs');
    expect(titleForPath('/s/abc')).toContain('Print at this shop');
    expect(titleForPath('/jobs/123')).toContain('Print status');
    expect(titleForPath('/')).toContain('skip the print queue');
  });
  it('titles unknown routes as not found', () => {
    expect(titleForPath('/nope/nothing')).toBe('Page not found · PrintQs');
  });
});
