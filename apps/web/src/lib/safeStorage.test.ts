import { afterEach, describe, expect, it } from 'vitest';
import { safeStorage } from './safeStorage.js';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('safeStorage', () => {
  it('works when the localStorage global throws on access (SecurityError)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    expect(() => safeStorage.set('k', 'v')).not.toThrow();
    expect(safeStorage.get('k')).toBe('v');
    expect(() => safeStorage.remove('k')).not.toThrow();
    expect(safeStorage.get('k')).toBeNull();
  });

  it('works when setItem throws (quota) and keeps an in-memory copy', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });
    safeStorage.set('a', '1');
    expect(safeStorage.get('a')).toBe('1');
  });

  it('persists through real storage when available', () => {
    const data = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => data.set(k, v),
        removeItem: (k: string) => data.delete(k),
      },
    });
    safeStorage.set('x', 'y');
    expect(data.get('x')).toBe('y');
  });
});
