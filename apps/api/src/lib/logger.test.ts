import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.js';

describe('HTTP request log privacy', () => {
  it('never serializes authentication or other request headers', () => {
    const writes: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        writes.push(String(chunk));
        callback();
      },
    });
    createLogger(destination).info({
      req: {
        method: 'POST',
        url: '/api/agent/heartbeat',
        headers: {
          'x-agent-token': 'agent-token-canary-never-log',
          authorization: 'Bearer authorization-canary-never-log',
          'x-razorpay-signature': 'webhook-signature-canary-never-log',
        },
      },
    }, 'privacy-regression');

    const output = writes.join('');
    expect(output).toContain('privacy-regression');
    expect(output).not.toContain('agent-token-canary-never-log');
    expect(output).not.toContain('authorization-canary-never-log');
    expect(output).not.toContain('webhook-signature-canary-never-log');
  });
});
