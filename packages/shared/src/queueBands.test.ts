import { describe, expect, it } from 'vitest';
import { assignBands, queueBand } from './queueBands.js';

describe('queueBand boundaries', () => {
  it.each([1, 2, 5, 20])('cap=%i splits at cap and 2*cap', (cap) => {
    expect(queueBand(1, cap)).toBe('revealed');
    expect(queueBand(cap, cap)).toBe('revealed');
    expect(queueBand(cap + 1, cap)).toBe('arriving');
    expect(queueBand(cap * 2, cap)).toBe('arriving');
    expect(queueBand(cap * 2 + 1, cap)).toBe('waiting');
  });
  it('is null when not in the line', () => {
    expect(queueBand(0, 5)).toBeNull();
    expect(queueBand(null, 5)).toBeNull();
    expect(queueBand(-1, 5)).toBeNull();
  });
});

const q = (n: number, revealedIds: string[] = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `j${i + 1}`, revealed: revealedIds.includes(`j${i + 1}`) }));

describe('assignBands', () => {
  it('matches the positional band when nothing is sticky', () => {
    for (const cap of [1, 2, 5, 20]) {
      const bands = assignBands(q(50), cap);
      for (let p = 1; p <= 50; p += 1) expect(bands.get(`j${p}`)).toBe(queueBand(p, cap));
    }
  });
  it('never un-reveals after capacity drops; no new reveals until slots free', () => {
    const bands = assignBands(q(10, ['j1', 'j2', 'j3', 'j4']), 2);
    expect(['j1', 'j2', 'j3', 'j4'].map((id) => bands.get(id))).toEqual(Array(4).fill('revealed'));
    expect(bands.get('j5')).toBe('arriving');
    expect(bands.get('j6')).toBe('arriving');
    expect(bands.get('j7')).toBe('waiting');
  });
  it('reveals only the free slots when capacity rises', () => {
    const bands = assignBands(q(6, ['j1', 'j2']), 4);
    expect(bands.get('j3')).toBe('revealed');
    expect(bands.get('j4')).toBe('revealed');
    expect(bands.get('j5')).toBe('arriving');
  });
  it('promotes the next job when a revealed job leaves', () => {
    const queue = [{ id: 'a', revealed: true }, { id: 'c', revealed: false }, { id: 'd', revealed: false }];
    const bands = assignBands(queue, 2);
    expect(bands.get('c')).toBe('revealed');
    expect(bands.get('d')).toBe('arriving');
  });
});
