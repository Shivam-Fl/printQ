import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Terms from './Terms.js';

describe('/terms (accepted by owners at shop signup)', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Terms)));

  it('states the platform fee owners accept and that students see it before ordering (PA-15)', () => {
    expect(html).toContain('currently 25% of the shop&#x27;s rate');
    expect(html).toContain('By registering, the shop owner accepts this fee.');
    expect(html).toContain('before they order');
  });

  it('describes self-serve signup, not the old campus-only, privately agreed commission', () => {
    expect(html).toContain('Any print shop can register');
    expect(html).not.toContain('participating campus print shop');
    expect(html).not.toMatch(/commission rate is the one/i);
  });
});
