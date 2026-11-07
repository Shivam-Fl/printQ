import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WINDOWS_DOWNLOAD_URL } from '../../lib/pcDownload.js';
import PcDownload from './PcDownload.js';

describe('/pc download page', () => {
  it('offers the Windows installer and 3 numbered steps without sign-in', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PcDownload)));
    expect(html).toContain(`href="${WINDOWS_DOWNLOAD_URL}"`);
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain('Install it and sign in');
  });
});
