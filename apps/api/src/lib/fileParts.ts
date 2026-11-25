/**
 * A composed order document is several of one student's ready uploads merged
 * into one print-ready PDF (UploadedFile.parts). Shared by the files routes,
 * the conversion worker and the retention scheduler.
 */
export type FilePart = { fileId: string; name: string; pages: number };

/** The parts of a composed order document, or null for an ordinary upload. */
export function readParts(value: unknown): FilePart[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parts = value.filter(
    (p): p is FilePart =>
      typeof p === 'object' && p !== null &&
      typeof (p as FilePart).fileId === 'string' &&
      typeof (p as FilePart).name === 'string' &&
      Number.isInteger((p as FilePart).pages),
  );
  return parts.length === value.length ? parts : null;
}

/** Display name of an order made of several files: "first.pdf +2 more". */
export function composedName(names: readonly string[]): string {
  const first = (names[0] ?? 'Document').slice(0, 120);
  return names.length <= 1 ? first : `${first} +${names.length - 1} more`;
}
