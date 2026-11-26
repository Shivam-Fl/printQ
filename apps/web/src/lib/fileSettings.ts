/**
 * Different copies / ink / sides for each file of an order. The choice is
 * kept per file id; a file without its own choice uses the order's settings.
 * The order is sent as print parts (one run per file, in print order), which
 * the shop's PC app prints one after another with their own settings.
 */
import { countSelectedPages, type PrintPart } from '@printq/shared';
import { fileRanges, type DocPart, type Excluded } from './pageSelection.js';

export interface FileSettings {
  copies: number;
  color: boolean;
  duplex: boolean;
}

export type PerFile = Readonly<Record<string, FileSettings>>;

export function settingsFor(fileId: string, perFile: PerFile, defaults: FileSettings): FileSettings {
  return perFile[fileId] ?? defaults;
}

/** Every file starts from the order's settings (files that already have their own keep them). */
export function seedPerFile(parts: readonly DocPart[], perFile: PerFile, defaults: FileSettings): PerFile {
  const next: Record<string, FileSettings> = { ...perFile };
  for (const part of parts) next[part.fileId] ??= { ...defaults };
  return next;
}

/** The print runs of a per-file order: each file's chosen pages with that file's settings. */
export function buildParts(parts: readonly DocPart[], excluded: Excluded, perFile: PerFile, defaults: FileSettings): PrintPart[] {
  return fileRanges(parts, excluded).map(({ fileId, pages }) => ({ pages, ...settingsFor(fileId, perFile, defaults) }));
}

/** Sheets of paper an order uses (two-sided runs use half, rounded up, per copy). */
export function sheetsFor(runs: readonly { pages: string | null; copies: number; duplex: boolean }[], totalPages: number): number {
  return runs.reduce((sum, run) => {
    const pages = countSelectedPages(run.pages, totalPages);
    return sum + (run.duplex ? Math.ceil(pages / 2) : pages) * run.copies;
  }, 0);
}

/** "Colour · 2 copies · both sides" */
export function settingsSummary(settings: FileSettings, duplexOffered = true): string {
  return [
    settings.color ? 'Colour' : 'B/W',
    `${settings.copies} ${settings.copies === 1 ? 'copy' : 'copies'}`,
    ...(duplexOffered ? [settings.duplex ? 'both sides' : 'one side'] : []),
  ].join(' · ');
}
