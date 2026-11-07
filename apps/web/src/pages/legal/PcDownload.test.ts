import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WINDOWS_DOWNLOAD_URL } from '../../lib/pcDownload.js';
import PcDownload from './PcDownload.js';

const render = (path: string) =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [path] }, createElement(PcDownload)));

describe('/pc download page', () => {
  it('offers the Windows installer and 3 numbered steps without sign-in', () => {
    const html = render('/pc');
    expect(html).toContain(`href="${WINDOWS_DOWNLOAD_URL}"`);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('Install it and sign in');
  });

  it('gives the size, Windows version and the SmartScreen "Run anyway" step under the button (PA-1)', () => {
    const html = render('/pc');
    expect(html).toContain('99 MB · Windows 10/11');
    expect(html).toContain('Unknown publisher');
    expect(html).toMatch(/More info.*Run anyway/);
  });

  it('sends /PC (typed in capitals) to /pc instead of rendering it under the wrong address (PA-14)', () => {
    expect(render('/PC')).toBe('');
    expect(render('/pc/')).toBe('');
  });
});
