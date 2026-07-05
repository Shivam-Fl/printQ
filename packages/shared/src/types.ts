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

export const PAPER_SIZES = ['A4', 'A3'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

export const FINISHING_OPTIONS = ['stapling', 'spiral_binding'] as const;
export type FinishingOption = (typeof FINISHING_OPTIONS)[number];

export const PRINTER_STATUSES = ['online', 'offline', 'jammed'] as const;
export type PrinterStatus = (typeof PRINTER_STATUSES)[number];

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const JOB_MODES = ['instant', 'scheduled'] as const;
export type JobMode = (typeof JOB_MODES)[number];

export interface JobSpecs {
  copies: number;
  paperSize: PaperSize;
  color: boolean;
  duplex: boolean;
  binding: FinishingOption | null;
  /** e.g. "1-5,8,11-12"; null = all pages */
  pageRange: string | null;
}

/** All money values are integer paise (INR). */
export interface RateCard {
  /** paise per printed page, keyed by `${size}_${color ? 'color' : 'bw'}` */
  pagePrices: Record<string, number>;
  /** paise per job for a finishing option */
  bindingPrices: Partial<Record<FinishingOption, number>>;
}

export interface PriceBreakdown {
  pagesPerCopy: number;
  copies: number;
  perPagePaise: number;
  pagesTotalPaise: number;
  bindingPaise: number;
  totalPaise: number;
}

export interface PrinterProfile {
  id: string;
  label: string;
  paperSizesLoaded: PaperSize[];
  colorSupport: boolean;
  finishingOptions: FinishingOption[];
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
