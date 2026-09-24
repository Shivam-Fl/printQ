import express from 'express';
import { describe, expect, it } from 'vitest';
import { counterReleaseLimiter } from './rateLimit.js';

describe('staff counter-code rate limit', () => {
  it('does not lock out valid multi-step releases, but limits invalid code guesses', async () => {
    const app = express();
    app.post('/release', counterReleaseLimiter, (req, res) => {
      res.status(req.query.invalid ? 400 : 200).json({ ok: !req.query.invalid });
    });
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test listener unavailable');
      const url = `http://127.0.0.1:${address.port}/release`;
      for (let index = 0; index < 15; index += 1) {
        const response = await fetch(url, { method: 'POST' });
        expect(response.status).toBe(200);
      }
      for (let index = 0; index < 10; index += 1) {
        const response = await fetch(`${url}?invalid=1`, { method: 'POST' });
        expect(response.status).toBe(400);
      }
      const blocked = await fetch(`${url}?invalid=1`, { method: 'POST' });
      expect(blocked.status).toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
