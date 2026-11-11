/**
 * Remembers a student's paper size and sides per shop, so a repeat order is
 * one tap. Colour, binding, copies and pages always start at the cheapest
 * default: a remembered setting must never silently make an order cost more.
 */
import { safeStorage } from './safeStorage.js';

export interface RememberedSettings {
  paperSize: string;
  duplex: boolean;
}

const key = (slug: string) => `printq:print-settings:${slug}`;

export function loadRemembered(slug: string): RememberedSettings | null {
  try {
    const raw = safeStorage.get(key(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RememberedSettings>;
    if (typeof parsed.paperSize !== 'string' || typeof parsed.duplex !== 'boolean') return null;
    return { paperSize: parsed.paperSize, duplex: parsed.duplex };
  } catch {
    return null;
  }
}

export function saveRemembered(slug: string, settings: RememberedSettings): void {
  safeStorage.set(key(slug), JSON.stringify({ paperSize: settings.paperSize, duplex: settings.duplex }));
}

/** Starting settings: the shop's first paper, one side, B/W, 1 copy, all pages; then what still applies from last time. */
export function startingSpecs(
  papers: { id: string }[],
  duplexEnabled: boolean,
  remembered: RememberedSettings | null,
): { copies: number; paperSize: string; color: boolean; duplex: boolean; binding: string | null; pageRange: string | null } {
  const paperSize = remembered && papers.some((p) => p.id === remembered.paperSize) ? remembered.paperSize : (papers[0]?.id ?? 'A4');
  return {
    copies: 1,
    paperSize,
    color: false,
    duplex: duplexEnabled && Boolean(remembered?.duplex),
    binding: null,
    pageRange: null,
  };
}
