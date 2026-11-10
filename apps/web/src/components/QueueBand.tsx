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

/** Small pill used on shop rows. */
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

/** "482913" -> ["482", "913"]: read aloud in two halves at the counter. */
export function codeHalves(code: string): [string, string] {
  return [code.slice(0, 3), code.slice(3)];
}

/**
 * The student's live-line card: one clear state per band.
 *  revealed -> the counter-code ticket (the product's one bold element) + countdown
 *  arriving -> "go to the counter" card with the position
 *  waiting  -> position only
 */
export function StudentBandPanel({ job, nowMs }: { job: BandJob; nowMs: number }) {
  const position = job.position;

  if (job.band === 'revealed' && job.otpCode) {
    const cd = countdownFor(job.revealDeadlineAt, nowMs);
    const [first, second] = codeHalves(job.otpCode);
    return (
      <div className={`ticket turn band-ticket${cd?.urgent ? ' urgent' : ''}`} data-band="revealed">
        <p className="ticket-title">Your turn</p>
        <div className="otp-band" data-counter-code aria-label={`Counter code ${job.otpCode.split('').join(' ')}`}>
          <span aria-hidden>{first}</span>
          <span aria-hidden>{second}</span>
        </div>
        {cd ? (
          <p className={`band-countdown${cd.urgent ? ' urgent' : ''}`} role="timer" aria-live="off">
            {cd.expired ? 'Be at the counter now' : `Be at the counter in ${cd.text}`}
          </p>
        ) : (
          <p className="band-countdown">Please be at the counter</p>
        )}
        {/* One polite announcement that changes only when urgency flips, never every second. */}
        <span className="sr-only" role="status">
          {cd?.urgent ? 'Hurry, only a few seconds left to reach the counter.' : 'It’s your turn. Please be at the counter.'}
        </span>
        <p className="sub">
          Show this code to staff. {cd ? 'If you are not there in time, you lose your place and check in again.' : 'They find your order with it.'}
        </p>
      </div>
    );
  }

  if (job.band === 'arriving') {
    return (
      <div className="now-card" data-band="arriving" role="status">
        <p className="now-kicker">Your turn is coming up</p>
        <p className="now-position num">{position === null ? 'Next' : `#${position}`}</p>
        <p className="now-body">Please head to the shop counter. Your code appears here when it is your turn.</p>
      </div>
    );
  }

  return (
    <div className="now-card" data-band={job.band ?? 'waiting'}>
      <p className="now-kicker">You are in line</p>
      <p className="now-position num">{position === null ? '·' : `#${position}`}</p>
      <p className="now-body">
        {job.etaMinutes !== null ? `About ${job.etaMinutes} min. ` : ''}We will tell you when to come to the counter. Stay nearby.
      </p>
    </div>
  );
}
