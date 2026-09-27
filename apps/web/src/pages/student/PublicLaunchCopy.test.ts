import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import Login from './Login.js';
import Welcome from './Welcome.js';

function renderPage(Page: typeof Welcome | typeof Login) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page)));
}

describe('public launch copy', () => {
  it('describes counter payment rather than remote online payment', () => {
    const home = renderPage(Welcome);
    const login = renderPage(Login);

    expect(home).toContain('Pay at the shop');
    expect(login).toContain('Pay at the shop');
    expect(home).not.toMatch(/upload and pay from anywhere|pay and track without waiting/i);
    expect(login).not.toMatch(/pay from your phone/i);
  });

  it('does not link students to a nonexistent demo shop', () => {
    expect(renderPage(Welcome)).not.toContain('/s/demo');
  });
});
