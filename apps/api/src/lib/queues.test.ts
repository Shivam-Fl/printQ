import { describe, expect, it } from 'vitest';
import { env } from '../config/env.js';
import { queueName } from './queues.js';

describe('environment queue namespace', () => {
  it('puts every queue in the explicit test namespace', () => {
    expect(queueName('convert')).toBe(`${env.QUEUE_NAMESPACE}-convert`);
    expect(queueName('file-retention')).toBe(`${env.QUEUE_NAMESPACE}-file-retention`);
  });
});
