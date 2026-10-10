/**
 * Parse a page-range string like "1-5,8,11-12" against a document's page count.
 * Returns the list of 1-based page numbers, validated and de-duplicated.
 * Throws on malformed input or out-of-bounds pages.
 */
export class PageRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageRangeError';
  }
}

export function parsePageRange(range: string, totalPages: number): number[] {
  const trimmed = range.trim();
  if (!/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/.test(trimmed)) {
    throw new PageRangeError('Use a format like 1-5,8');
  }
  const pages = new Set<number>();
  for (const part of trimmed.split(',')) {
    const [startStr, endStr] = part.trim().split('-');
    const start = Number(startStr);
    const end = endStr !== undefined ? Number(endStr) : start;
    if (start < 1 || end > totalPages || start > end) {
      throw new PageRangeError('Selected pages are outside this document');
    }
    for (let p = start; p <= end; p++) pages.add(p);
  }
  return [...pages].sort((a, b) => a - b);
}

/** Number of pages selected by a range (or all pages when range is null). */
export function countSelectedPages(range: string | null, totalPages: number): number {
  if (!range) return totalPages;
  return parsePageRange(range, totalPages).length;
}

/**
 * Canonical display form of a page range: sorted, de-duplicated and merged
 * ("1-3,3,5,4" -> "1-5"). Null/empty means all pages. Falls back to the input
 * trimmed if it cannot be parsed against the page count.
 */
export function normalizePageRange(range: string | null, totalPages: number | null): string | null {
  if (!range || !range.trim()) return null;
  try {
    const pages = parsePageRange(range, totalPages ?? Number.MAX_SAFE_INTEGER);
    const parts: string[] = [];
    let start = pages[0]!;
    let prev = start;
    for (const p of [...pages.slice(1), Infinity]) {
      if (p === prev + 1) {
        prev = p;
        continue;
      }
      parts.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = p;
      prev = p;
    }
    return parts.join(',');
  } catch {
    return range.trim();
  }
}
