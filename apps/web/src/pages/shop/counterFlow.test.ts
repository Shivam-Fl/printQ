import { describe, expect, it } from 'vitest';
import {
  counterErrorText, inFlightJobs, lineGroups, nextStep, outOfTurnText, preparedJobs, releaseStep, sanitizeCode,
  spacedCode, specsSummary, studentLabel, type QueueJob,
} from './counterFlow.js';

const job = (over: Partial<QueueJob> = {}): QueueJob => ({
  id: 'j1',
  status: 'queued',
  mode: 'instant',
  scheduledTime: null,
  specs: { copies: 1, paperSize: 'A4', color: false, duplex: false, binding: null, pageRange: null },
  pagesPerCopy: 12,
  totalPaise: 3000,
  paymentStatus: 'counter_due',
  paymentProvider: 'pay_at_shop',
  cashCollectedAt: null,
  counterPaymentMethod: null,
  counterPaymentConfirmedAt: null,
  assignedPrinterId: 'p1',
  otpExpiresAt: null,
  printError: null,
  printAttempts: 0,
  spoolAcceptedAt: null,
  printConfirmedAt: null,
  printCompletionMethod: null,
  queuedAt: '2026-11-10T10:00:00Z',
  arrivedAt: '2026-11-10T10:00:00Z',
  checkInCount: 1,
  position: 1,
  band: 'revealed',
  revealDeadlineAt: null,
  absent: false,
  createdAt: '2026-11-10T09:00:00Z',
  student: { name: 'Priya Nair', phoneMasked: '•••0002' },
  file: { originalName: 'lab.pdf', pages: 12 },
  ...over,
});

describe('counter code entry', () => {
  it('keeps digits only, at most six, so pasted codes just work', () => {
    expect(sanitizeCode('140 724')).toBe('140724');
    expect(sanitizeCode('140-724')).toBe('140724');
    expect(sanitizeCode('code: 1407249')).toBe('140724');
    expect(sanitizeCode('abc')).toBe('');
  });
  it('groups the code 3 + 3 for reading aloud', () => {
    expect(spacedCode('140724')).toBe('140 724');
    expect(spacedCode('14')).toBe('14');
  });
});

describe('order summary', () => {
  it('says pages, copies, paper, ink, sides, binding and range in counter words', () => {
    expect(specsSummary(job())).toBe('12 pages · A4 · B/W');
    expect(specsSummary(job({ pagesPerCopy: 1, specs: { copies: 3, paperSize: 'A3', color: true, duplex: true, binding: 'spiral_binding', pageRange: '1-4' } })))
      .toBe('1 page × 3 copies · A3 · Colour · both sides · Spiral binding · pages 1-4');
  });
  it('falls back to the masked phone when the student has no name', () => {
    expect(studentLabel(job({ student: { name: null, phoneMasked: '•••0009' } }))).toBe('•••0009');
    expect(studentLabel(job({ student: { name: '  ', phoneMasked: '•••0009' } }))).toBe('•••0009');
  });
});

describe('line grouping', () => {
  it('splits the checked-in line into its bands, in line order', () => {
    const jobs = [
      job({ id: 'w', position: 4, band: 'waiting' }),
      job({ id: 'c2', position: 2, band: 'revealed' }),
      job({ id: 'a', position: 3, band: 'arriving' }),
      job({ id: 'c1', position: 1, band: 'revealed' }),
      job({ id: 'p', status: 'awaiting_arrival', position: null, band: null }),
      job({ id: 'x', status: 'printing', position: null, band: null }),
    ];
    const g = lineGroups(jobs);
    expect(g.atCounter.map((j) => j.id)).toEqual(['c1', 'c2']);
    expect(g.comingUp.map((j) => j.id)).toEqual(['a']);
    expect(g.waiting.map((j) => j.id)).toEqual(['w']);
  });
  it('lists prepared orders by planned time, then age', () => {
    const list = preparedJobs([
      job({ id: 'late', status: 'awaiting_arrival', scheduledTime: '2026-11-11T09:00:00Z' }),
      job({ id: 'old', status: 'awaiting_arrival', createdAt: '2026-11-10T08:00:00Z' }),
    ]);
    expect(list.map((j) => j.id)).toEqual(['old', 'late']);
  });
  it('puts the newest release first in Printing & pickup', () => {
    const list = inFlightJobs([
      job({ id: 'old-jam', status: 'otp_verified', printError: 'Paper jam', counterPaymentConfirmedAt: '2026-11-10T08:00:00Z' }),
      job({ id: 'new', status: 'printing', counterPaymentConfirmedAt: '2026-11-10T10:05:00Z' }),
      job({ id: 'queued', status: 'queued' }),
    ]);
    expect(list.map((j) => j.id)).toEqual(['new', 'old-jam']);
  });
});

describe('the one next action for a released job', () => {
  it('printing without binding: Printed OK · hand over, or printed for later', () => {
    const s = nextStep(job({ status: 'printing', spoolAcceptedAt: '2026-11-10T10:00:00Z' }));
    expect(s.primary).toEqual({ action: 'printedHandover', label: 'Printed OK · hand over' });
    expect(s.secondary.map((x) => x.action)).toEqual(['printedOnly']);
  });
  it('printing with binding: confirm the print, then the binding starts', () => {
    const s = nextStep(job({ status: 'printing', specs: { ...job().specs, binding: 'spiral_binding' } }));
    expect(s.primary?.action).toBe('printedStartBinding');
    expect(s.primary?.label).toBe('Printed OK · start spiral binding');
  });
  it('a failed print offers Retry and, for a counter-paid order, returning the money', () => {
    const s = nextStep(job({ status: 'otp_verified', printError: 'The printer reported a problem.', counterPaymentConfirmedAt: '2026-11-10T10:00:00Z' }));
    expect(s.tone).toBe('danger');
    expect(s.primary?.action).toBe('retry');
    expect(s.secondary.map((x) => x.action)).toEqual(['returnPayment']);
  });
  it('a print whose computer went offline: confirm if it printed, else print again', () => {
    const s = nextStep(job({ status: 'printing', printAgentOffline: true }));
    expect(s.tone).toBe('danger');
    expect(s.primary?.action).toBe('printedHandover');
    expect(s.secondary[0]?.action).toBe('retry');
  });
  it('finishing and ready', () => {
    expect(nextStep(job({ status: 'finishing', specs: { ...job().specs, binding: 'stapling' } })).primary?.label).toBe('Stapling done · hand over');
    expect(nextStep(job({ status: 'ready_for_pickup' })).primary?.action).toBe('handover');
    expect(nextStep(job({ status: 'otp_verified' })).primary).toBeNull();
  });
});

describe('release answers', () => {
  it('maps every API answer to the next counter step', () => {
    expect(releaseStep({ requiresQueueOverride: true, jobId: 'j', position: 4, queueStatus: 'queued' })).toEqual({ kind: 'outOfTurn', jobId: 'j', position: 4, queueStatus: 'queued' });
    expect(releaseStep({ requiresManualAssignment: true, jobId: 'j', eligiblePrinters: [{ printerId: 'p', estimatedWaitMinutes: 2 }] }).kind).toBe('choosePrinter');
    expect(releaseStep({ requiresPaymentConfirmation: true, counterPaymentAmountPaise: 3000, selectedPrinterId: 'p', jobId: 'j' })).toEqual({ kind: 'collect', jobId: 'j', amountPaise: 3000, printerId: 'p' });
    expect(releaseStep({ ok: true }).kind).toBe('sent');
  });
  it('explains out-of-turn and failures in plain words', () => {
    expect(outOfTurnText(4, 'queued')).toMatch(/#4 in line/);
    expect(outOfTurnText(null, 'awaiting_arrival')).toMatch(/Not checked in/);
    expect(counterErrorText({ status: 400, message: 'Invalid OTP', body: { code: 'OTP_INVALID' } })).toBe('No order has this code. Check the 6 digits with the student.');
    expect(counterErrorText({ status: 409, message: 'This order is already printed and ready for pickup' })).toMatch(/already printed/);
    expect(counterErrorText({ status: 409, message: 'This order has already been released to a printer' })).toMatch(/already printing/);
    expect(counterErrorText({ status: 0, message: 'Can’t reach PrintQs. Check your internet and try again.' })).toMatch(/Can’t reach/);
  });
});

describe('history search', () => {
  it('finds a student by name, phone digits or file', async () => {
    const { matchesHistory } = await import('./History.js');
    const row = { student: { name: 'Priya Nair', phoneMasked: '••••• 00002' }, file: 'Physics-lab-record.pdf' };
    expect(matchesHistory(row, 'priya')).toBe(true);
    expect(matchesHistory(row, '0002')).toBe(true);
    expect(matchesHistory(row, 'physics')).toBe(true);
    expect(matchesHistory(row, 'rohan')).toBe(false);
    expect(matchesHistory(row, '  ')).toBe(true);
  });
});
