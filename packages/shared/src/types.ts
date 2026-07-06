/** Job lifecycle states — see printQ.md §8. Transitions live in stateMachine.ts. */
export const JOB_STATUSES = [
  'pending_payment',
  'queued',
  'notified',
  'otp_verified',
  'printing',
  'ready_for_pickup',
  'completed',
  'no_show',
  'requeued',
  'expired',
  'cancelled',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const PRINTER_STATUSES = ['online', 'offline', 'jammed'] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const JOB_MODES = ['instant', 'scheduled'] as const;
export type JobMode = (typeof JOB_MODES)[number];

/**
 * Print options are shop-defined (printQ.md — each shop sets its own paper
 * types, incl. custom "college sheet", binding choices and prices). Paper and
 * binding on a job are therefore free-form ids that must match one of the
 * shop's configured options; the server validates + prices against them.
 */
export interface PaperOption {
  /** stable id used in specs + printer capabilities, e.g. "A4", "college" */
  id: string;
  label: string;
  bwPaise: number;
  /** null = this paper is B/W only */
  colorPaise: number | null;
}

export interface BindingOption {
  id: string;
  label: string;
  paise: number;
}

export interface PrintOptions {
  papers: PaperOption[];
  bindings: BindingOption[];
  duplexEnabled: boolean;
}

export interface JobSpecs {
  copies: number;
  /** a PaperOption id offered by the shop */
  paperSize: string;
  color: boolean;
  duplex: boolean;
  /** a BindingOption id, or null for none */
  binding: string | null;
  /** e.g. "1-5,8,11-12"; null = all pages */
  pageRange: string | null;
}

export interface PriceBreakdown {
  paperLabel: string;
  pagesPerCopy: number;
  copies: number;
  perPagePaise: number;
  pagesTotalPaise: number;
  bindingLabel: string | null;
  bindingPaise: number;
  totalPaise: number;
}

export interface PrinterProfile {
  id: string;
  label: string;
  /** PaperOption ids this printer currently has loaded */
  paperSizesLoaded: string[];
  colorSupport: boolean;
  /** BindingOption ids this printer can produce */
  finishingOptions: string[];
  avgPagesPerMinute: number;
  status: PrinterStatus;
}

/** Minimal job view the assignment algorithm needs. */
export interface QueuedJobLite {
  id: string;
  assignedPrinterId: string | null;
  pages: number;
  copies: number;
}
