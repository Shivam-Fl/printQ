/**
 * Page-by-page selection for an order made of one or more files.
 *
 * The student picks pages per FILE (so adding, removing or reordering files
 * never scrambles a choice already made). The order itself is one joined
 * document, so the choice is compiled into the order's page range over that
 * document: each file's pages follow the previous file's, in print order.
 */
import { MAX_PAGE_RANGE_LENGTH, formatPageList, parsePageRange } from '@printq/shared';

export interface DocPart {
  fileId: string;
  name: string;
  pages: number;
}

/** Pages left out of the print, per file (1-based page numbers within that file). */
export type Excluded = Readonly<Record<string, readonly number[]>>;

export interface PageRef {
  fileId: string;
  /** page within its own file */
  page: number;
  /** page within the joined order document */
  docPage: number;
  partIndex: number;
}

/** Every page of the order in print order, with its place in the joined document. */
export function orderPages(parts: readonly DocPart[]): PageRef[] {
  const out: PageRef[] = [];
  let offset = 0;
  parts.forEach((part, partIndex) => {
    for (let page = 1; page <= part.pages; page++) out.push({ fileId: part.fileId, page, docPage: offset + page, partIndex });
    offset += part.pages;
  });
  return out;
}

export function isExcluded(excluded: Excluded, fileId: string, page: number): boolean {
  return excluded[fileId]?.includes(page) ?? false;
}

export function partSelectedCount(part: DocPart, excluded: Excluded): number {
  const skipped = new Set((excluded[part.fileId] ?? []).filter((p) => p >= 1 && p <= part.pages));
  return part.pages - skipped.size;
}

export function selectedCount(parts: readonly DocPart[], excluded: Excluded): number {
  return parts.reduce((sum, part) => sum + partSelectedCount(part, excluded), 0);
}

export function totalPages(parts: readonly DocPart[]): number {
  return parts.reduce((sum, part) => sum + part.pages, 0);
}

/**
 * The order's page range over the joined document: null when every page
 * prints, '' when nothing is selected (the order cannot be placed).
 */
export function compileRange(parts: readonly DocPart[], excluded: Excluded): string | null {
  const pages = orderPages(parts);
  const chosen = pages.filter((ref) => !isExcluded(excluded, ref.fileId, ref.page)).map((ref) => ref.docPage);
  if (chosen.length === pages.length) return null;
  return formatPageList(chosen);
}

/** Why the compiled range cannot be ordered, or null when it can. */
export function rangeProblem(range: string | null): string | null {
  if (range === null) return null;
  if (range === '') return 'Choose at least one page to print.';
  if (range.length > MAX_PAGE_RANGE_LENGTH) return 'That is a lot of separate pieces. Choose fewer, longer runs of pages.';
  return null;
}

/** A typed range ("1-5, 8") over the joined document, as exclusions per file. Throws PageRangeError. */
export function excludedFromRange(parts: readonly DocPart[], range: string): Record<string, number[]> {
  const chosen = new Set(parsePageRange(range, totalPages(parts)));
  const out: Record<string, number[]> = {};
  for (const ref of orderPages(parts)) {
    if (chosen.has(ref.docPage)) continue;
    (out[ref.fileId] ??= []).push(ref.page);
  }
  return out;
}

/** The same choice as a short range over the joined document ("" for every page). */
export function rangeText(parts: readonly DocPart[], excluded: Excluded): string {
  return compileRange(parts, excluded) ?? '';
}

export function togglePage(excluded: Excluded, fileId: string, page: number): Excluded {
  const current = excluded[fileId] ?? [];
  const next = current.includes(page) ? current.filter((p) => p !== page) : [...current, page];
  return withPart(excluded, fileId, next);
}

/** Select (include = true) or skip every page of one file. */
export function setPartPages(excluded: Excluded, part: DocPart, include: boolean): Excluded {
  return withPart(excluded, part.fileId, include ? [] : Array.from({ length: part.pages }, (_, i) => i + 1));
}

/** Select or skip every page of the order. */
export function setAllPages(parts: readonly DocPart[], include: boolean): Excluded {
  return parts.reduce<Excluded>((acc, part) => setPartPages(acc, part, include), {});
}

function withPart(excluded: Excluded, fileId: string, pages: readonly number[]): Excluded {
  const { [fileId]: _drop, ...rest } = excluded;
  return pages.length > 0 ? { ...rest, [fileId]: [...pages].sort((a, b) => a - b) } : rest;
}

/**
 * Each file's chosen pages as a range over the joined document, in print
 * order; files with no page chosen are left out. One entry per file = one
 * print run with that file's own settings.
 */
export function fileRanges(parts: readonly DocPart[], excluded: Excluded): { fileId: string; pages: string }[] {
  const out: { fileId: string; pages: string }[] = [];
  for (const ref of groupByFile(orderPages(parts))) {
    const chosen = ref.pages.filter((p) => !isExcluded(excluded, ref.fileId, p.page)).map((p) => p.docPage);
    if (chosen.length > 0) out.push({ fileId: ref.fileId, pages: formatPageList(chosen) });
  }
  return out;
}

function groupByFile(pages: PageRef[]): { fileId: string; pages: PageRef[] }[] {
  const groups: { fileId: string; pages: PageRef[] }[] = [];
  for (const ref of pages) {
    const last = groups.at(-1);
    if (last && last.fileId === ref.fileId) last.pages.push(ref);
    else groups.push({ fileId: ref.fileId, pages: [ref] });
  }
  return groups;
}
