import { useEffect, useState } from 'react';
import type { QueueBand } from '@printq/shared';

/** Seconds left that turn the countdown urgent (red, pulsing). */
export const URGENT_SECONDS = 10;

export interface Countdown {
  /** "0:42" */
  text: string;
  seconds: number;
  urgent: boolean;
  expired: boolean;
}

export function countdownFor(deadlineIso: string | null | undefined, nowMs: number): Countdown | null {
  if (!deadlineIso) return null;
  const deadline = new Date(deadlineIso).getTime();
  if (Number.isNaN(deadline)) return null;
  const seconds = Math.max(0, Math.ceil((deadline - nowMs) / 1000));
  const text = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return { text, seconds, urgent: seconds <= URGENT_SECONDS, expired: seconds === 0 };
}

/** Re-renders every second while `active`; returns epoch ms. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const BAND_LABEL: Record<QueueBand, string> = {
  revealed: 'at the counter',
  arriving: 'coming up',
  waiting: 'waiting',
};

/** Small pill used on the shop dashboard rows. */
export function BandPill({ band, deadline, nowMs }: { band: QueueBand | null; deadline?: string | null; nowMs: number }) {
  if (!band) return null;
  const cd = band === 'revealed' ? countdownFor(deadline, nowMs) : null;
  return (
    <span className={`band-pill ${band}${cd?.urgent ? ' urgent' : ''}`} data-band={band}>
      {BAND_LABEL[band]}
      {cd && <b> · {cd.text}</b>}
    </span>
  );
}

export interface BandJob {
  status: string;
  position: number | null;
  etaMinutes: number | null;
  band: QueueBand | null;
  revealDeadlineAt: string | null;
  otpCode: string | null;
}

/**
 * The student's live-line card: one clear state per band.
 *  revealed -> perforated counter-code ticket + countdown
 *  arriving -> "head to the shop" banner + position
 *  waiting  -> position only
 */
export function StudentBandPanel({ job, nowMs }: { job: BandJob; nowMs: number }) {
  const position = job.position;
  const positionTicket = (
    <div className="ticket">
      <div className="eyebrow">live walk-in position</div>
      <div className="ticket-num">{position === null ? '·' : `#${position}`}</div>
      <div className="sub">
        {job.etaMinutes !== null ? `roughly ${job.etaMinutes} min` : 'position is advisory'}
      </div>
    </div>
  );

  if (job.band === 'revealed' && job.otpCode) {
    const cd = countdownFor(job.revealDeadlineAt, nowMs);
    return (
      <div className={`ticket turn band-ticket${cd?.urgent ? ' urgent' : ''}`} data-band="revealed">
        <div className="eyebrow">it’s your turn</div>
        {cd ? (
          <div className={`band-countdown${cd.urgent ? ' urgent' : ''}`} role="timer" aria-live="off">
            {cd.expired ? 'Be at the counter now' : `Be at the counter in ${cd.text}`}
          </div>
        ) : (
          <div className="band-countdown">Please be at the counter</div>
        )}
        {/* One polite announcement that changes only when urgency flips, never every second. */}
        <span className="sr-only" role="status">
          {cd?.urgent ? 'Hurry, only a few seconds left to reach the counter.' : 'It’s your turn. Please be at the counter.'}
        </span>
        <div className="otp-band">{job.otpCode}</div>
        <div className="sub">
          Tell staff this code. {cd ? 'If you are not there in time you lose your place and must check in again.' : 'Staff can find your order with it.'}
        </div>
      </div>
    );
  }

  if (job.band === 'arriving') {
    return (
      <>
        <div className="band-banner" data-band="arriving" role="status">
          <strong>Your turn is coming up — please head to the shop.</strong>
          <span>
            You are {position === null ? 'next in line' : `#${position} in line`}. Your counter code appears here when it is your turn.
          </span>
        </div>
        {positionTicket}
      </>
    );
  }

  return (
    <>
      {positionTicket}
      {job.band === 'waiting' && (
        <p className="band-hint" data-band="waiting">We will alert you when your turn is coming up. Stay nearby.</p>
      )}
    </>
  );
}
