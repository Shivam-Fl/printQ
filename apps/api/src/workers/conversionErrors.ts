import { EncryptedPDFError } from 'pdf-lib';

/**
 * Conversion failures are mapped to a small closed set of codes. Only the code
 * is stored in UploadedFile.error and only its fixed, friendly message ever
 * reaches a student. The raw error (library internals, paths, stack traces)
 * stays in the redacted server log.
 */
export const CONVERSION_ERRORS = {
  FILE_CORRUPT: "We couldn't read this file — it looks damaged. Re-save or re-export it and upload again.",
  FILE_ENCRYPTED: 'This PDF is password protected — remove the password and upload again.',
  FILE_UNSUPPORTED: "This kind of file can't be printed here. Upload a PDF, DOCX, JPG or PNG.",
  FILE_TOO_LARGE: 'This file is too large to process. Try a smaller or compressed version.',
  TOO_MANY_PAGES: 'This document has too many pages for one order. Split it and upload the parts separately.',
  CONVERSION_TIMEOUT: 'Preparing this file took too long. Try again, or upload it as a PDF.',
  CONVERSION_FAILED: 'We hit a problem preparing this file. Please try again in a moment.',
} as const;

export type ConversionErrorCode = keyof typeof CONVERSION_ERRORS;

/** Hard cap on pages in one converted document. */
export const MAX_DOCUMENT_PAGES = 500;

export class ConversionError extends Error {
  constructor(
    public readonly code: ConversionErrorCode,
    public readonly rawCause?: unknown,
  ) {
    super(code);
    this.name = 'ConversionError';
  }
}

/**
 * pdf-lib is compiled to ES5, so `instanceof EncryptedPDFError` is unreliable;
 * fall back to its stable message.
 */
export function isEncryptedPdfError(err: unknown): boolean {
  return (
    err instanceof EncryptedPDFError ||
    (err instanceof Error && /PDFDocument\.load` is encrypted/.test(err.message))
  );
}

export const isConversionErrorCode = (value: unknown): value is ConversionErrorCode =>
  typeof value === 'string' && Object.hasOwn(CONVERSION_ERRORS, value);

/** Failures a retry cannot fix; BullMQ should not re-run these. */
export function isPermanent(code: ConversionErrorCode): boolean {
  return code !== 'CONVERSION_FAILED' && code !== 'CONVERSION_TIMEOUT';
}

/** Map anything thrown during conversion to one of the closed codes. */
export function classifyConversionError(err: unknown): ConversionErrorCode {
  if (err instanceof ConversionError) return err.code;
  if (isEncryptedPdfError(err)) return 'FILE_ENCRYPTED';
  const e = err as { killed?: boolean; signal?: string; code?: string | number } | null;
  if (e && (e.killed === true || e.signal === 'SIGTERM' || e.code === 'ETIMEDOUT')) return 'CONVERSION_TIMEOUT';
  return 'CONVERSION_FAILED';
}

/**
 * What the API returns for a stored UploadedFile.error. Legacy rows that hold
 * a raw message (written before codes existed) collapse to the generic text.
 */
export function publicFileError(stored: string | null): { error: string; errorCode: ConversionErrorCode } | null {
  if (!stored) return null;
  const errorCode = isConversionErrorCode(stored) ? stored : 'CONVERSION_FAILED';
  return { error: CONVERSION_ERRORS[errorCode], errorCode };
}
