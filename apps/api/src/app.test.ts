import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { errorHandler } from './middleware/error.js';
import { mountWebApp } from './webApp.js';

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe('request body errors (OWN-9)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => ({ server, base } = await listen(createApp())));
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/auth/shop/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });

  it('returns 400 (not 500) for malformed JSON, without echoing parser details', async () => {
    const res = await post('{"email": "a@b.co", ');
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; code?: string };
    expect(json.error).toBe('Request body is not valid JSON');
    expect(json.code).toBe('INVALID_JSON');
    expect(JSON.stringify(json)).not.toMatch(/Unexpected|position|token|SyntaxError/i);
  });

  it('returns 413 (not 500) when the body is over the limit', async () => {
    const res = await post(JSON.stringify({ shopName: 'x'.repeat(2 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    const json = (await res.json()) as { error: string; code?: string };
    expect(json.code).toBe('BODY_TOO_LARGE');
    expect(json.error).toMatch(/too large/i);
  });

  it('still shapes a normal validation failure', async () => {
    const res = await post(JSON.stringify({ shopName: 'A Shop', address: '12 Lane', ownerName: 'O', email: 'nope', password: 'short' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { details: { path: string; message: string }[] };
    expect(json.details).toEqual(expect.arrayContaining([
      { path: 'email', message: 'Email is invalid' },
      { path: 'password', message: 'Password must be at least 8 characters' },
    ]));
  });

  it('shapes parser errors the same way on any route', async () => {
    const res = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad',
    });
    expect(res.status).toBe(400);
  });
});

describe('single-domain web serving (DEF-01)', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'printq-web-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>SPA</title>');
    writeFileSync(path.join(dist, 'robots.txt'), 'User-agent: *\nAllow: /\n');
    writeFileSync(path.join(dist, 'assets', 'app.js'), 'console.log(1)');
    const app = express();
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    mountWebApp(app, dist);
    app.use((_req, res) => res.status(404).json({ error: 'Not found' }));
    app.use(errorHandler);
    ({ server, base } = await listen(app));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves a real robots.txt, not the SPA shell', async () => {
    const res = await fetch(`${base}/robots.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(await res.text()).toContain('Allow: /');
  });

  it('serves existing static assets', async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/javascript/);
  });

  it.each(['/sitemap.xml', '/assets/missing.js', '/favicon.ico', '/nested/dir/file.css', '/.env'])(
    'returns 404 (not index.html) for the unknown file %s',
    async (p) => {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('<title>SPA</title>');
    },
  );

  it.each(['/', '/dashboard/settings', '/s/some-shop', '/shops'])('still falls back to the SPA for the client route %s', async (p) => {
    const res = await fetch(`${base}${p}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>SPA</title>');
  });

  it('keeps unknown /api paths as JSON 404s', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('Not found');
  });

  it('ships a robots.txt in the web app that hides private areas', () => {
    const file = path.resolve(import.meta.dirname, '../../web/public/robots.txt');
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^Allow: \/$/m);
    for (const p of ['/dashboard/', '/admin/', '/api/']) expect(text).toContain(`Disallow: ${p}`);
  });
});
