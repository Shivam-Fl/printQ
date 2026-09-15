import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'x'.repeat(64);
process.env.OTP_PEPPER ??= 'y'.repeat(32);
process.env.CORS_ORIGINS = 'https://allowed.example';

let server: Server;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

describe('CORS origin validation', () => {
  it('returns JSON 403 without ACAO for an unapproved origin', async () => {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Origin is not allowed', code: 'CORS_ORIGIN_DENIED' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows an approved origin', async () => {
    const port = (server.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { Origin: 'https://allowed.example' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://allowed.example');
  });
});
