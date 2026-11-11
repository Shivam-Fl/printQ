import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, api, rupees } from '../../api.js';
import {
  CODE_LENGTH, collectsPayment, counterErrorText, outOfTurnText, releaseStep, sanitizeCode, spacedCode, specsSummary,
  studentLabel, type QueueJob, type ReleaseResponse, type ReleaseStep,
} from './counterFlow.js';

export interface PrinterLite {
  id: string;
  label: string;
  status: string;
}

export interface SentReceipt {
  text: string;
}

interface Props {
  jobs: QueueJob[];
  printers: PrinterLite[];
  /** The shop's merchant UPI ID is verified, so "UPI received" is allowed. */
  upiReady: boolean;
  isOwner: boolean;
  /** Reload the queue (a looked-up job may not be in the list yet). */
  reload: () => Promise<void> | void;
  onSent: (receipt: SentReceipt) => void;
  /** Bumped by the page after other counter actions, to put the cursor back in the code box. */
  focusSignal: number;
}

type Phase = 'idle' | 'looking' | 'result' | 'sending';

/**
 * The counter's one input. Typing the 6th digit looks the order up (the same
 * POST /api/shop/release the old "Find" button sent): pay-at-shop orders stop
 * there until staff confirm cash or UPI, so a lookup never prints or records money.
 */
export default function CounterCode({ jobs, printers, upiReady, isOwner, reload, onSent, focusSignal }: Props) {
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [step, setStep] = useState<ReleaseStep | null>(null);
  const [overrideQueue, setOverrideQueue] = useState(false);
  const [printerChoice, setPrinterChoice] = useState('');
  const [reference, setReference] = useState('');
  const [showReference, setShowReference] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const request = useRef(0);

  useEffect(() => { input.current?.focus(); }, [focusSignal]);

  const job = step?.jobId ? jobs.find((j) => j.id === step.jobId) ?? null : null;
  const printerLabel = (id?: string | null) => (id ? printers.find((p) => p.id === id)?.label ?? 'the assigned printer' : null);

  // a looked-up order that is not in the list yet (it just arrived): fetch the list once
  const missing = Boolean(step?.jobId) && !job;
  useEffect(() => {
    if (missing) void reload();
  }, [missing, reload]);

  function clear(refocus = true) {
    request.current += 1;
    setCode('');
    setPhase('idle');
    setStep(null);
    setOverrideQueue(false);
    setPrinterChoice('');
    setReference('');
    setShowReference(false);
    setError('');
    if (refocus) input.current?.focus();
  }

  function apply(res: ReleaseResponse, from: string, override: boolean): void {
    const next = releaseStep(res);
    if (next.kind === 'sent') {
      const sentJob = next.jobId ? jobs.find((j) => j.id === next.jobId) : job;
      const printer = printerLabel(printerChoice || (step?.kind === 'collect' ? step.printerId : null) || sentJob?.assignedPrinterId);
      onSent({ text: `Sent${printer ? ` to ${printer}` : ' to the printer'}${sentJob ? ` · ${studentLabel(sentJob)}` : ''} · code ${spacedCode(from)}` });
      clear();
      return;
    }
    setStep(next);
    setOverrideQueue(override);
    if (next.kind === 'choosePrinter') setPrinterChoice(next.eligible[0]?.printerId ?? '');
    setPhase('result');
  }

  async function lookup(value: string, override = false) {
    const ticket = ++request.current;
    setPhase('looking');
    setError('');
    try {
      const res = await api<ReleaseResponse>('/api/shop/release', {
        method: 'POST',
        role: 'shop',
        body: { otp: value, overrideQueue: override },
      });
      if (ticket !== request.current) return; // the code was edited meanwhile
      apply(res, value, override);
    } catch (err) {
      if (ticket !== request.current) return;
      setPhase('idle');
      setStep(null);
      setError(counterErrorText(err instanceof ApiError ? err : { message: (err as Error)?.message }));
    }
  }

  async function send(method: 'cash' | 'shop_upi' | null) {
    if (!step || phase === 'sending') return;
    const ticket = ++request.current;
    const printerId = step.kind === 'choosePrinter' ? printerChoice : step.kind === 'collect' ? step.printerId : undefined;
    setPhase('sending');
    setError('');
    try {
      const res = await api<ReleaseResponse>('/api/shop/release', {
        method: 'POST',
        role: 'shop',
        body: {
          otp: code,
          overrideQueue,
          ...(printerId ? { printerId } : {}),
          ...(method ? { paymentConfirmation: { method, ...(reference.trim() ? { reference: reference.trim() } : {}) } } : {}),
        },
      });
      if (ticket !== request.current) return;
      const next = releaseStep(res);
      if (next.kind === 'sent') {
        const printer = printerLabel(printerId ?? job?.assignedPrinterId);
        const amount = job ? rupees(step.kind === 'collect' ? step.amountPaise : job.totalPaise) : null;
        onSent({
          text: `Sent${printer ? ` to ${printer}` : ' to the printer'}${job ? ` · ${studentLabel(job)}` : ''}${method && amount ? ` · ${amount} ${method === 'cash' ? 'cash' : 'UPI'}` : ''}`,
        });
        clear();
        return;
      }
      apply(res, code, overrideQueue);
    } catch (err) {
      if (ticket !== request.current) return;
      setPhase('result');
      setError(counterErrorText(err instanceof ApiError ? err : { message: (err as Error)?.message }));
    }
  }

  function onChange(raw: string) {
    const next = sanitizeCode(raw);
    if (next === code) return;
    request.current += 1; // a lookup for the old code is no longer wanted
    setCode(next);
    setStep(null);
    setOverrideQueue(false);
    setError('');
    setPhase('idle');
    if (next.length === CODE_LENGTH) void lookup(next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Enter only retries a lookup; it never confirms money (a habitual second Enter is harmless)
    if (event.key === 'Enter' && code.length === CODE_LENGTH && phase === 'idle') void lookup(code);
  }

  function onPanelKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && (code || step || error)) {
      event.preventDefault();
      clear();
    }
  }

  const amountPaise = step?.kind === 'collect' ? step.amountPaise : job?.totalPaise ?? null;
  const needsPayment = job ? collectsPayment(job) : step?.kind === 'collect';
  const busy = phase === 'looking' || phase === 'sending';
  const printerLine = step?.kind === 'collect' ? printerLabel(step.printerId) : step?.kind === 'choosePrinter' ? null : printerLabel(job?.assignedPrinterId);

  return (
    <section className="code-panel" aria-labelledby="counter-code-label" onKeyDown={onPanelKey}>
      <div className="code-entry">
        <label id="counter-code-label" htmlFor="counter-code">Counter code</label>
        <input
          id="counter-code"
          ref={input}
          className="code-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          enterKeyHint="search"
          maxLength={CODE_LENGTH + 2}
          placeholder="••••••"
          value={code}
          aria-describedby="counter-code-help"
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          autoFocus
        />
        <p id="counter-code-help" className="code-help">
          {phase === 'looking' ? 'Finding the order…' : code.length > 0 && code.length < CODE_LENGTH ? `${CODE_LENGTH - code.length} more digit${CODE_LENGTH - code.length === 1 ? '' : 's'}` : 'Type the 6 digits the student shows you.'}
        </p>
        {code.length === CODE_LENGTH && phase === 'idle' && !step && (
          <button type="button" className="secondary" onClick={() => void lookup(code)}>Find order</button>
        )}
      </div>

      {error && <p className="code-error" role="alert">{error}</p>}

      {step && (
        <div className={`order-card${step.kind === 'outOfTurn' ? ' warn' : ''}`} aria-live="polite">
          {job ? (
            <div className="order-who">
              <strong className="order-name">{studentLabel(job)}</strong>
              {job.student.name && <span className="order-phone">{job.student.phoneMasked}</span>}
              <span className="order-file" title={job.file.originalName}>{job.file.originalName}</span>
              <span className="order-specs">{specsSummary(job)}</span>
            </div>
          ) : (
            <div className="order-who"><strong className="order-name">Order found</strong><span className="order-specs">Loading the details…</span></div>
          )}

          {step.kind === 'outOfTurn' ? (
            <>
              <p className="order-warning"><strong>Out of turn.</strong> {outOfTurnText(step.position, step.queueStatus)}</p>
              <div className="order-actions">
                <button type="button" className="secondary large warn-button" disabled={busy} onClick={() => void lookup(code, true)}>Print anyway</button>
                <button type="button" className="quiet" disabled={busy} onClick={() => clear()}>Keep queue order</button>
              </div>
            </>
          ) : (
            <>
              {step.kind === 'choosePrinter' ? (
                step.eligible.length === 0 ? (
                  <p className="order-warning">
                    <strong>No printer can print this right now.</strong> Check that a printer with {job?.specs.paperSize ?? 'this paper'}{job?.specs.color ? ' and colour' : ''} is on.{' '}
                    <Link to="/dashboard/printers">Open printers</Link>
                  </p>
                ) : (
                  <div className="order-printer">
                    <label htmlFor="counter-printer">Print on</label>
                    <select id="counter-printer" value={printerChoice} onChange={(e) => setPrinterChoice(e.target.value)}>
                      {step.eligible.map((p, i) => (
                        <option key={p.printerId} value={p.printerId}>
                          {printerLabel(p.printerId)} · about {p.estimatedWaitMinutes} min{i === 0 ? ' (recommended)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                )
              ) : (
                printerLine && <p className="order-printer-line">Prints on <strong>{printerLine}</strong></p>
              )}

              {(step.kind === 'collect' || step.kind === 'choosePrinter') && (step.kind !== 'choosePrinter' || step.eligible.length > 0) && (
                needsPayment ? (
                  amountPaise != null ? (
                    <>
                      <p className="order-amount"><span>Collect</span> <strong className="num">{rupees(amountPaise)}</strong></p>
                      <div className="order-actions">
                        <button type="button" className="large" disabled={busy} onClick={() => void send('cash')}>
                          {phase === 'sending' ? 'Sending…' : 'Cash received & print'}
                        </button>
                        {upiReady && (
                          <button type="button" className="secondary large" disabled={busy} onClick={() => void send('shop_upi')}>UPI received & print</button>
                        )}
                        <button type="button" className="quiet" disabled={busy} onClick={() => clear()}>Not paid yet</button>
                      </div>
                      {upiReady ? (
                        showReference ? (
                          <div className="order-reference">
                            <label htmlFor="counter-payment-reference">UPI reference <span className="optional-label">optional</span></label>
                            <input id="counter-payment-reference" maxLength={120} value={reference} onChange={(e) => setReference(e.target.value)} />
                          </div>
                        ) : (
                          <button type="button" className="quiet small-quiet" onClick={() => setShowReference(true)}>Add a UPI reference</button>
                        )
                      ) : (
                        <p className="order-note">UPI is not set up for this shop{isOwner ? <>. <Link to="/dashboard/settings#payments">Add your UPI ID</Link> to accept UPI here.</> : ', so only cash can be recorded.'}</p>
                      )}
                      <p className="order-note">Check the money in your drawer or your UPI app first. A payment screenshot is not proof.</p>
                    </>
                  ) : null
                ) : (
                  <div className="order-actions">
                    <button type="button" className="large" disabled={busy} onClick={() => void send(null)}>Print now</button>
                    <button type="button" className="quiet" disabled={busy} onClick={() => clear()}>Cancel</button>
                  </div>
                )
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
