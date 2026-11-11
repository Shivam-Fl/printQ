import type { QueueBand } from '@printq/shared';

export type StatusTone = 'neutral' | 'blue' | 'green' | 'red' | 'yellow';

export interface StatusMeta {
  label: string;
  tone: StatusTone;
  active: boolean;
}

/** Student-facing status words: what the order is doing, in plain words. */
export const STATUS: Record<string, StatusMeta> = {
  pending_payment: { label: 'preparing', tone: 'neutral', active: true },
  awaiting_arrival: { label: 'prepared', tone: 'neutral', active: true },
  queued: { label: 'in line', tone: 'blue', active: true },
  notified: { label: 'your turn', tone: 'yellow', active: true },
  otp_verified: { label: 'sending to printer', tone: 'blue', active: true },
  printing: { label: 'printing', tone: 'blue', active: true },
  finishing: { label: 'finishing', tone: 'blue', active: true },
  ready_for_pickup: { label: 'ready to collect', tone: 'green', active: true },
  completed: { label: 'collected', tone: 'green', active: false },
  no_show: { label: 'missed turn', tone: 'red', active: true },
  requeued: { label: 'rejoining', tone: 'blue', active: true },
  expired: { label: 'expired', tone: 'red', active: false },
  cancelled: { label: 'cancelled', tone: 'red', active: false },
};

export const statusMeta = (s: string): StatusMeta =>
  STATUS[s] ?? { label: s.replace(/_/g, ' '), tone: 'blue', active: false };

/** Badge class for a status tone ("stamp" alone is the neutral grey). */
export const stampClass = (tone: StatusTone) => (tone === 'neutral' ? 'stamp' : `stamp ${tone}`);

/** The badge for one order on its own page: a called student reads "Your turn", not "In line". */
export function jobBadge(job: { status: string; band?: QueueBand | null; absent?: boolean }): StatusMeta {
  const base = statusMeta(job.status);
  if ((job.status === 'queued' || job.status === 'notified') && job.band === 'revealed') return { ...base, label: 'your turn', tone: 'yellow' };
  if (job.status === 'queued' && job.band === 'arriving') return { ...base, label: 'coming up', tone: 'yellow' };
  if (job.status === 'awaiting_arrival' && job.absent) return { ...base, label: 'missed turn', tone: 'red' };
  return base;
}

/** One line about what to do next, for order lists (Home, My jobs). */
export function nextStepLine(job: { status: string; checkInCount?: number; mode?: string }): string {
  switch (job.status) {
    case 'pending_payment': return 'Preparing your order';
    case 'awaiting_arrival':
      if ((job.checkInCount ?? 0) > 0) return 'Missed your turn · check in again at the shop';
      return job.mode === 'scheduled' ? 'Planned visit · tap I’m here at the shop' : 'Go to the shop and tap I’m here';
    case 'queued':
    case 'notified': return 'In line · open to see your place or code';
    case 'otp_verified': return 'Sending to the printer';
    case 'printing': return 'Printing now';
    case 'finishing': return 'Finishing by hand';
    case 'ready_for_pickup': return 'Ready · collect at the counter';
    case 'completed': return 'Collected';
    case 'cancelled': return 'Cancelled';
    case 'expired': return 'Expired';
    default: return statusMeta(job.status).label;
  }
}

export interface SpecsLite {
  copies: number;
  paperSize: string;
  color: boolean;
  duplex: boolean;
  binding: string | null;
  pageRange: string | null;
}

export function specsText(s: SpecsLite, pagesPerCopy?: number): string {
  return (
    `${s.copies}× ${s.paperSize} · ${s.color ? 'Colour' : 'B/W'}` +
    `${s.duplex ? ' · both sides' : ''}` +
    `${s.binding ? ` · ${s.binding.replace('_', ' ')}` : ''}` +
    `${s.pageRange ? ` · pages ${s.pageRange}` : ''}` +
    `${pagesPerCopy ? ` · ${pagesPerCopy}pp` : ''}`
  );
}
