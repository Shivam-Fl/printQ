import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const spa = config.rewrites.find((r) => r.destination === '/index.html');
// Vercel anchors `source` as a full-path regex.
const matches = (path) => new RegExp(`^${spa.source}$`).test(path);

test('SPA routes fall back to index.html', () => {
  for (const p of ['/', '/home', '/jobs', '/jobs/abc-123', '/login', '/shops', '/s/campus-copy-centre', '/shop/dashboard', '/.well-known/x']) {
    assert.equal(matches(p), true, p);
  }
});

test('file-like paths are not rewritten, so they 404 instead of returning HTML', () => {
  for (const p of ['/foo.png', '/x.js', '/sitemap.xml', '/a/b/c.css', '/robots.txt', '/sw.js', '/favicon.ico']) {
    assert.equal(matches(p), false, p);
  }
});

test('static asset prefixes are never rewritten', () => {
  for (const p of ['/assets/missing', '/icons/x', '/downloads/y']) {
    assert.equal(matches(p), false, p);
  }
});
