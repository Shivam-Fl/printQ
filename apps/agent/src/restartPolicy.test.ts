import { describe, expect, it } from 'vitest';
import { restartDelayMs } from './restartPolicy.js';

describe('restartDelayMs', () => {
  it('backs off repeated crashes and caps the retry interval', () => {
    expect(restartDelayMs(0)).toBe(1_000);
    expect(restartDelayMs(1)).toBe(2_000);
    expect(restartDelayMs(5)).toBe(30_000);
    expect(restartDelayMs(99)).toBe(30_000);
  });
});
