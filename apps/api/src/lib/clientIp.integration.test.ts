import express from 'express';
import rateLimit from 'express-rate-limit';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from './clientIp.js';

const cf = parseTrustProxy('cloudflare');
const CLIENT = '49.36.10.20';

describe('rate limiting keyed by the resolved client (Express integration)', () => {
  it('shares one counter across rotating Cloudflare edges and ignores spoofed headers', async () => {
    const app = express();
    app.set('trust proxy', cf);
    app.use(rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false }));
    app.get('/', (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const statuses: number[] = [];
      const edges = ['172.69.1.1', '104.23.9.9', '162.159.4.4', '172.70.8.8', '108.162.200.1', '141.101.70.1', '190.93.241.2'];
      for (const [i, edge] of edges.entries()) {
        const res = await fetch(`http://127.0.0.1:${port}/`, {
          // attacker rotates both the edge and a forged prefix on every request
          headers: { 'x-forwarded-for': `10.9.${i}.1, ${CLIENT}, ${edge}`, 'cf-connecting-ip': `8.8.${i}.8` },
        });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429]);
      // a different real client is unaffected
      const other = await fetch(`http://127.0.0.1:${port}/`, {
        headers: { 'x-forwarded-for': '50.1.1.1, 172.69.100.5' },
      });
      expect(other.status).toBe(200);
    } finally {
      server.close();
    }
  });
});
