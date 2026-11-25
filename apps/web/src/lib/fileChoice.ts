/**
 * Checks a student's chosen files before anything is uploaded, so a wrong
 * type or an oversized file is explained at once, next to that file, instead
 * of failing the whole batch on the server. The server re-checks everything.
 */

/** Same ceilings as the API (apps/api/src/modules/files/routes.ts). */
export const MAX_ORDER_FILES = 15;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export const FILE_ACCEPT =
  '.pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export type FileKind = 'pdf' | 'word' | 'image';

const EXTENSION_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'word',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The kind of a chosen file, or null when it cannot be printed here. */
export function fileKind(name: string, type = ''): FileKind | null {
  const byExtension = EXTENSION_KIND[extensionOf(name)];
  if (byExtension) return byExtension;
  // camera captures can arrive without a usable name
  if (!extensionOf(name) && (type === 'image/jpeg' || type === 'image/png')) return 'image';
  return null;
}

/** Why this file cannot be added, in plain words, or null when it can. */
export function localFileProblem(file: { name: string; size: number; type?: string }): string | null {
  if (!fileKind(file.name, file.type)) {
    const ext = extensionOf(file.name);
    if (ext === 'doc') return 'Old Word files (.doc) can’t be printed. Save it as .docx or PDF and add it again.';
    if (ext === 'heic' || ext === 'heif') return 'iPhone HEIC photos can’t be printed. Use “Take a photo” or share it as JPG.';
    return 'Only PDF, Word (.docx), JPG and PNG files can be printed.';
  }
  if (file.size === 0) return 'This file is empty.';
  if (file.size > MAX_FILE_BYTES) return `This file is ${formatBytes(file.size)}. Each file can be up to 25 MB.`;
  return null;
}

/** 820 KB, 2.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** Splits chosen files into those that fit in the order and how many did not. */
export function fitToRoom<T>(files: readonly T[], alreadyInOrder: number): { take: T[]; overflow: number } {
  const room = Math.max(0, MAX_ORDER_FILES - alreadyInOrder);
  return { take: files.slice(0, room), overflow: Math.max(0, files.length - room) };
}
