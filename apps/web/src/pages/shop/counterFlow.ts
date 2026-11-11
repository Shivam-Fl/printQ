/**
 * The counter's rules, DOM-free so they are unit-tested: code entry, what the
 * release API answered, how the line is grouped, and the one next action for
 * every job that is printing or waiting to be collected.
 */
import type { QueueBand } from '@printq/shared';
import { jobActions } from './queueActions.js';

export interface QueueJob {
  id: string;
  status: string;
  mode: 'instant' | 'scheduled';
  scheduledTime: string | null;
  specs: {
    copies: number;
    paperSize: string;
    color: boolean;
    duplex: boolean;
    binding: string | null;
    pageRange: string | null;
  };
  pagesPerCopy: number;
  totalPaise: number;
  paymentStatus: 'pending' | 'counter_due' | 'cash_due' | 'paid' | 'refunding' | 'refunded' | 'failed';
  paymentProvider: string | null;
  cashCollectedAt: string | null;
  counterPaymentMethod: 'cash' | 'shop_upi' | null;
  counterPaymentConfirmedAt: string | null;
  assignedPrinterId: string | null;
  otpExpiresAt: string | null;
  printError: string | null;
  printErrorCode?: string | null;
  /** Server-computed: the computer that was printing this job is offline or gone. */
  printAgentOffline?: boolean;
  printAttempts: number;
  spoolAcceptedAt: string | null;
  printConfirmedAt: string | null;
  printCompletionMethod: 'simulator' | 'staff_confirmed' | null;
  queuedAt: string | null;
  arrivedAt: string | null;
  checkInCount: number;
  /** Server-computed: 1-based place in the live line and its counter band. */
  position: number | null;
  band: QueueBand | null;
  /** Called students must reach the counter by this time (null = no timer). */
  revealDeadlineAt: string | null;
  /** Marked absent earlier; must check in again to rejoin. */
  absent: boolean;
  createdAt: string;
  student: { name: string | null; phoneMasked: string };
  file: { originalName: string; pages: number | null };
}

export const CODE_LENGTH = 6;

/** Digits only, at most six: pasting "140 724" or "140-724" just works. */
export function sanitizeCode(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
}

/** "140724" -> "140 724" for reading aloud at the counter. */
export function spacedCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function bindingLabel(binding: string | null): string | null {
  if (!binding) return null;
  const words = binding.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "12 pages × 3 copies · A4 · B/W · both sides · Spiral binding · pages 1-4" */
export function specsSummary(job: Pick<QueueJob, 'specs' | 'pagesPerCopy'>): string {
  const { specs } = job;
  const parts = [
    `${plural(job.pagesPerCopy, 'page')}${specs.copies > 1 ? ` × ${specs.copies} copies` : ''}`,
    specs.paperSize,
    specs.color ? 'Colour' : 'B/W',
  ];
  if (specs.duplex) parts.push('both sides');
  const binding = bindingLabel(specs.binding);
  if (binding) parts.push(binding);
  if (specs.pageRange) parts.push(`pages ${specs.pageRange}`);
  return parts.join(' · ');
}

export function studentLabel(job: Pick<QueueJob, 'student'>): string {
  return job.student.name?.trim() || job.student.phoneMasked;
}

/** Pay-at-shop money is still to be collected at the counter. */
export function collectsPayment(job: Pick<QueueJob, 'paymentStatus'>): boolean {
  return job.paymentStatus === 'counter_due' || job.paymentStatus === 'cash_due';
}

export interface LineGroups {
  atCounter: QueueJob[];
  comingUp: QueueJob[];
  waiting: QueueJob[];
}

/** The walk-in line in its three bands, each in line order. */
export function lineGroups(jobs: QueueJob[]): LineGroups {
  const line = jobs
    .filter((j) => j.status === 'queued' || j.status === 'notified')
    .sort((a, b) => (a.position ?? 9e9) - (b.position ?? 9e9));
  return {
    atCounter: line.filter((j) => j.band === 'revealed'),
    comingUp: line.filter((j) => j.band === 'arriving'),
    waiting: line.filter((j) => j.band !== 'revealed' && j.band !== 'arriving'),
  };
}

/** Ordered but not here yet: planned time first, then oldest. */
export function preparedJobs(jobs: QueueJob[]): QueueJob[] {
  return jobs
    .filter((j) => j.status === 'awaiting_arrival')
    .sort((a, b) => new Date(a.scheduledTime ?? a.createdAt).getTime() - new Date(b.scheduledTime ?? b.createdAt).getTime());
}

const IN_FLIGHT = ['otp_verified', 'printing', 'finishing', 'ready_for_pickup'];

/** When the job was released at the counter (payment confirmed), or the best earlier time we know. */
function releasedAt(j: QueueJob): number {
  return new Date(j.counterPaymentConfirmedAt ?? j.arrivedAt ?? j.createdAt).getTime();
}

/**
 * Released jobs, newest release first: the student in front of the counter is the
 * one just served, so their print sits at the top. Problems stay red wherever they are.
 */
export function inFlightJobs(jobs: QueueJob[]): QueueJob[] {
  return jobs.filter((j) => IN_FLIGHT.includes(j.status)).sort((a, b) => releasedAt(b) - releasedAt(a));
}

export type JobAction =
  | 'printedHandover' // confirm printed, then hand over (student is at the counter)
  | 'printedOnly' // confirm printed, student collects later
  | 'printedStartBinding' // confirm printed; manual finishing starts
  | 'finishingHandover' // binding done, hand over now
  | 'finishingOnly' // binding done, student collects later
  | 'handover'
  | 'retry'
  | 'returnPayment';

export interface NextStep {
  tone: 'info' | 'ok' | 'warn' | 'danger';
  status: string;
  detail: string | null;
  primary: { action: JobAction; label: string } | null;
  secondary: { action: JobAction; label: string }[];
}

/** The one thing staff do next with a released job. */
export function nextStep(job: QueueJob): NextStep {
  const actions = jobActions(job);
  const binding = bindingLabel(job.specs.binding);
  const returnPayment = actions.paymentReturned ? [{ action: 'returnPayment' as const, label: 'Cancel & return payment' }] : [];
  if (job.status === 'otp_verified' && job.printError) {
    return { tone: 'danger', status: 'Print problem', detail: job.printError, primary: { action: 'retry', label: 'Retry print' }, secondary: returnPayment };
  }
  if (job.status === 'otp_verified') {
    return { tone: 'info', status: 'Sending to printer', detail: null, primary: null, secondary: [] };
  }
  if (job.status === 'printing') {
    const printed = binding
      ? { action: 'printedStartBinding' as const, label: `Printed OK · start ${binding.toLowerCase()}` }
      : { action: 'printedHandover' as const, label: 'Printed OK · hand over' };
    const later = binding ? [] : [{ action: 'printedOnly' as const, label: 'Printed, student not here yet' }];
    if (job.printAgentOffline) {
      return {
        tone: 'danger',
        status: 'Printer computer went offline',
        detail: 'Check whether it printed. If it did not, print it again.',
        primary: printed,
        secondary: [{ action: 'retry', label: 'Print again' }, ...returnPayment],
      };
    }
    return {
      tone: 'info',
      status: job.spoolAcceptedAt ? 'Printed? Check the pages' : 'Printing',
      detail: null,
      primary: printed,
      secondary: later,
    };
  }
  if (job.status === 'finishing') {
    return {
      tone: 'warn',
      status: `${binding ?? 'Finishing'} by hand`,
      detail: null,
      primary: { action: 'finishingHandover', label: `${binding ?? 'Finishing'} done · hand over` },
      secondary: [{ action: 'finishingOnly', label: 'Done, student not here yet' }],
    };
  }
  return { tone: 'ok', status: 'Ready to collect', detail: null, primary: { action: 'handover', label: 'Hand over' }, secondary: [] };
}

/** What POST /api/shop/release answered, as the next thing the counter shows. */
export interface ReleaseResponse {
  ok?: boolean;
  requiresManualAssignment?: boolean;
  requiresQueueOverride?: boolean;
  requiresPaymentConfirmation?: boolean;
  counterPaymentAmountPaise?: number;
  selectedPrinterId?: string;
  jobId?: string;
  position?: number | null;
  queueStatus?: string;
  eligiblePrinters?: { printerId: string; estimatedWaitMinutes: number }[];
}

export type ReleaseStep =
  | { kind: 'sent'; jobId?: string }
  | { kind: 'outOfTurn'; jobId?: string; position: number | null; queueStatus: string }
  | { kind: 'choosePrinter'; jobId?: string; eligible: { printerId: string; estimatedWaitMinutes: number }[] }
  | { kind: 'collect'; jobId?: string; amountPaise: number; printerId?: string };

export function releaseStep(res: ReleaseResponse): ReleaseStep {
  if (res.requiresQueueOverride) return { kind: 'outOfTurn', jobId: res.jobId, position: res.position ?? null, queueStatus: res.queueStatus ?? 'outside_queue' };
  if (res.requiresManualAssignment) return { kind: 'choosePrinter', jobId: res.jobId, eligible: res.eligiblePrinters ?? [] };
  if (res.requiresPaymentConfirmation && res.counterPaymentAmountPaise != null) {
    return { kind: 'collect', jobId: res.jobId, amountPaise: res.counterPaymentAmountPaise, printerId: res.selectedPrinterId };
  }
  return { kind: 'sent', jobId: res.jobId };
}

/** Why a student is not "at the counter" yet, in counter words. */
export function outOfTurnText(position: number | null, queueStatus: string): string {
  if (position !== null) return `Not called yet: #${position} in line. Printing now serves them out of turn.`;
  if (queueStatus === 'awaiting_arrival') return 'Not checked in at the shop yet. Printing now serves them before the line.';
  return 'Not in the walk-in line right now. Printing now serves them before the line.';
}

/** Plain words for a failed lookup or release. */
export function counterErrorText(err: { status?: number; message?: string; body?: unknown }): string {
  const code = (err.body as { code?: string } | undefined)?.code;
  if (code === 'OTP_INVALID' || /invalid otp/i.test(err.message ?? '')) return 'No order has this code. Check the 6 digits with the student.';
  if (err.status === 409 && /already printed|ready for pickup/i.test(err.message ?? '')) return 'This order is already printed. Find it under Printing & pickup.';
  if (err.status === 409 && /already been released/i.test(err.message ?? '')) return 'This order is already printing. Find it under Printing & pickup.';
  if (err.status === 409 && /merchant UPI/i.test(err.message ?? '')) return 'UPI is not set up for this shop yet. Take cash, or add your UPI ID in Shop → Settings.';
  return err.message || 'That did not work. Try again.';
}

/** History search: matches a student name, the last digits of a phone, or a file name. */
export function matchesHistory(row: { student: { name: string | null; phoneMasked: string }; file: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.student.name ?? '', row.student.phoneMasked, row.file].some((text) => text.toLowerCase().includes(q));
}
