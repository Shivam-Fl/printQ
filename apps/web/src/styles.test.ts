import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('styles.css', () => {
  // An undefined custom property silently drops the whole declaration
  // (e.g. --rule-dark left the phone and search fields with no border at all).
  it('defines every custom property it uses without a fallback', () => {
    const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]));
    expect(used.has('--rule-dark')).toBe(true);
    expect([...used].filter((name) => !defined.has(name))).toEqual([]);
  });
});
