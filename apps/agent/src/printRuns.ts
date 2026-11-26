/**
 * How a claimed job is printed: once with its own settings, or, for an order
 * with different settings per file, one run per part.
 */
/** One run of an order with different settings per file (the server's JobSpecs.parts). */
export interface PrintPart {
  pages: string;
  copies: number;
  color: boolean;
  duplex: boolean;
}

export interface ClaimedSpecs {
  copies: number;
  duplex: boolean;
  color: boolean;
  paperSize: string;
  parts?: PrintPart[] | null;
}

/**
 * What this app can do, sent on every request (x-agent-features). The server
 * offers students different settings per file only when every online PC of
 * the shop says "print-parts", and never hands such an order to an older app.
 */
export const AGENT_FEATURES = 'print-parts';

/** The print runs of a claimed job: one per part, or the whole document once. */
export function printRuns(jobId: string, specs: ClaimedSpecs): { file: string; copies: number; duplex: boolean; color: boolean; spoolId: string }[] {
  const parts = specs.parts ?? [];
  if (parts.length === 0) {
    return [{ file: `/api/agent/jobs/${jobId}/file`, copies: specs.copies, duplex: specs.duplex, color: specs.color, spoolId: jobId }];
  }
  return parts.map((part, index) => ({
    file: `/api/agent/jobs/${jobId}/file?part=${index}`,
    copies: part.copies,
    duplex: part.duplex,
    color: part.color,
    spoolId: `${jobId}-part${index + 1}`,
  }));
}
