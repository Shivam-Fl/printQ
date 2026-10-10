/**
 * localStorage that never throws. Browsers can deny storage (private modes,
 * blocked site data, sandboxed iframes) by throwing on *access* to the global
 * itself; every read/write here is guarded and falls back to memory for the
 * life of the page so the app keeps working (just without persistence).
 */
const memory = new Map<string, string>();

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export const safeStorage = {
  get(key: string): string | null {
    try {
      const s = store();
      if (s) {
        const value = s.getItem(key);
        if (value !== null) return value;
      }
    } catch {
      /* fall through to memory */
    }
    return memory.get(key) ?? null;
  },
  set(key: string, value: string): void {
    try {
      const s = store();
      if (s) {
        s.setItem(key, value);
        memory.delete(key);
        return;
      }
    } catch {
      /* quota or denied: fall back to memory for this page */
    }
    memory.set(key, value);
  },
  remove(key: string): void {
    memory.delete(key);
    try {
      store()?.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
