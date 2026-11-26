/** Job lifecycle states — see printQ.md §8. Transitions live in stateMachine.ts. */
export const JOB_STATUSES = [
  'pending_payment',
  'awaiting_arrival',
  'queued',
  'notified',
  'otp_verified',
  'printing',
  'finishing',
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

export const PAYMENT_STATUSES = ['pending', 'cash_due', 'paid', 'refunding', 'refunded', 'failed'] as const;
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
  /**
   * Different settings per file of a multi-file order: each part prints as
   * its own run with its own copies/ink/sides. When present the server sets
   * the order-level copies (1), color/duplex (any part) and pageRange (all
   * parts' pages) as summaries; paper and binding stay order-wide.
   */
  parts?: PrintPart[] | null;
}

export interface PrintPart {
  /** the pages of the order document this part prints, e.g. "1-6" */
  pages: string;
  copies: number;
  color: boolean;
  duplex: boolean;
}

/** One priced run of a multi-part order. */
export interface PriceLine {
  pages: number;
  copies: number;
  color: boolean;
  perPagePaise: number;
  totalPaise: number;
}

export interface PriceBreakdown {
  paperLabel: string;
  pagesPerCopy: number;
  copies: number;
  perPagePaise: number;
  pagesTotalPaise: number;
  bindingLabel: string | null;
  bindingPaise: number;
  /** amount taken off by a coupon, already folded into totalPaise */
  discountPaise: number;
  totalPaise: number;
  /**
   * Per-part runs of an order with different settings per file. Then
   * pagesPerCopy is every printed page (pages x copies of each part), copies
   * is 1, and perPagePaise is the shared rate (0 when the parts differ).
   */
  lines?: PriceLine[];
}

/** A resolved, still-valid coupon — expiry/redemption/shop-scope already checked. */
export interface ResolvedCoupon {
  code: string;
  percentOff: number | null;
  paiseOff: number | null;
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
