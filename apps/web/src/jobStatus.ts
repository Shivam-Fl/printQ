export interface StatusMeta {
  label: string;
  tone: 'blue' | 'green' | 'red' | 'yellow';
  active: boolean;
}

export const STATUS: Record<string, StatusMeta> = {
  pending_payment: { label: 'awaiting payment', tone: 'yellow', active: true },
  queued: { label: 'in queue', tone: 'blue', active: true },
  notified: { label: 'your turn', tone: 'yellow', active: true },
  otp_verified: { label: 'sending to printer', tone: 'blue', active: true },
  printing: { label: 'printing', tone: 'blue', active: true },
  ready_for_pickup: { label: 'ready to collect', tone: 'green', active: true },
  completed: { label: 'completed', tone: 'green', active: false },
  no_show: { label: 'missed turn', tone: 'red', active: true },
  requeued: { label: 'rejoining', tone: 'blue', active: true },
  expired: { label: 'expired', tone: 'red', active: false },
  cancelled: { label: 'cancelled', tone: 'red', active: false },
};

export const statusMeta = (s: string): StatusMeta =>
  STATUS[s] ?? { label: s.replace(/_/g, ' '), tone: 'blue', active: false };

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
