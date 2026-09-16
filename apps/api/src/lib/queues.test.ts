import { describe, expect, it } from 'vitest';
import { queueName } from './queues.js';

describe('environment queue namespace', () => {
  it('puts every queue in the explicit test namespace', () => {
    expect(queueName('convert')).toBe('printq-test-convert');
    expect(queueName('file-retention')).toBe('printq-test-file-retention');
  });
});
