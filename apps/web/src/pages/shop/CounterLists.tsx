import { useState } from 'react';
import { ApiError, api, rupees } from '../../api.js';
import { countdownFor, useNow } from '../../components/QueueBand.js';
import {
  nextStep, preparedJobs, specsSummary, studentLabel, type JobAction, type LineGroups, type QueueJob,
} from './counterFlow.js';
import type { PrinterLite } from './CounterCode.js';

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message : fallback;
}

/** Runs one card action through the existing endpoints (two calls in order for "… · hand over"). */
async function runAction(job: QueueJob, action: JobAction): Promise<string> {
  const post = (path: string, body?: unknown) => api(`/api/shop/jobs/${job.id}/${path}`, { method: 'POST', role: 'shop', ...(body ? { body } : {}) });
  const who = studentLabel(job);
  switch (action) {
    case 'printedHandover': {
      const r = await api<{ finishingRequired: boolean }>(`/api/shop/jobs/${job.id}/confirm-print-completion`, { method: 'POST', role: 'shop' });
      if (r.finishingRequired) return `Printed · ${who}: finishing by hand`;
      await post('handover');
      return `Handed over · ${who}`;
    }
    case 'printedOnly':
    case 'printedStartBinding': {
      const r = await api<{ finishingRequired: boolean }>(`/api/shop/jobs/${job.id}/confirm-print-completion`, { method: 'POST', role: 'shop' });
      return r.finishingRequired ? `Printed · ${who}: binding next` : `Printed · ${who} was told to collect`;
    }
    case 'finishingHandover':
      await post('finishing-complete');
      await post('handover');
      return `Handed over · ${who}`;
    case 'finishingOnly':
      await post('finishing-complete');
      return `Ready · ${who} was told to collect`;
    case 'handover':
      await post('handover');
      return `Handed over · ${who}`;
    case 'retry':
      await post('retry-print', {});
      return `Printing again · ${who}`;
    case 'returnPayment':
      await post('counter-payment-returned', {});
      return `Payment return recorded · ${who}'s order closed`;
  }
}

function InFlightCard({ job, printers, onDone }: { job: QueueJob; printers: PrinterLite[]; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = nextStep(job);
  const printer = printers.find((p) => p.id === job.assignedPrinterId)?.label;

  async function act(action: JobAction) {
    if (busy) return;
    if (action === 'returnPayment'
      && !confirm(`Give ${rupees(job.totalPaise)} back to ${studentLabel(job)} first. This closes the order and records the return.`)) return;
    setBusy(true);
    setError('');
    try {
      onDone(await runAction(job, action));
    } catch (err) {
      setError(errorText(err, 'That did not work. Try again.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`job-card tone-${step.tone}`} data-job-card={job.id}>
      <div className="job-card-head">
        <strong className="job-name">{studentLabel(job)}</strong>
        <span className={`badge ${step.tone === 'info' ? 'info' : step.tone}`}>{step.status}</span>
      </div>
      <p className="job-file" title={job.file.originalName}>{job.file.originalName}</p>
      <p className="job-meta">{specsSummary(job)}{printer ? ` · ${printer}` : ''}</p>
      {step.detail && <p className="job-detail">{step.detail}</p>}
      {(step.primary || step.secondary.length > 0) && (
        <div className="job-actions">
          {step.primary && (
            <button type="button" disabled={busy} onClick={() => void act(step.primary!.action)}>
              {busy ? 'Saving…' : step.primary.label}
            </button>
          )}
          {step.secondary.map((s) => (
            <button key={s.action} type="button" className={s.action === 'returnPayment' ? 'quiet danger-text' : 'quiet'} disabled={busy} onClick={() => void act(s.action)}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      {error && <p className="job-error" role="alert">{error}</p>}
    </li>
  );
}

export function InFlightPanel({ jobs, printers, loading, onDone }: { jobs: QueueJob[]; printers: PrinterLite[]; loading: boolean; onDone: (text: string) => void }) {
  return (
    <section className="inflight-panel" aria-labelledby="inflight-title">
      <div className="panel-head">
        <h2 id="inflight-title">Printing &amp; pickup</h2>
        {!loading && <span className="count" aria-label={`${jobs.length} jobs`}>{jobs.length}</span>}
      </div>
      {loading ? (
        <div className="skeleton-list" aria-hidden><div className="skeleton-card" /></div>
      ) : jobs.length === 0 ? (
        <p className="panel-empty">Nothing printing. Orders appear here after you confirm payment.</p>
      ) : (
        <>
          <p className="panel-help">Check every page before you press Printed OK. The file is deleted 10 minutes later.</p>
          <ul className="job-cards">
            {jobs.map((job) => <InFlightCard key={job.id} job={job} printers={printers} onDone={onDone} />)}
          </ul>
        </>
      )}
    </section>
  );
}

function LineRow({ job, nowMs, onAbsent }: { job: QueueJob; nowMs: number; onAbsent?: (job: QueueJob) => void }) {
  const cd = job.band === 'revealed' ? countdownFor(job.revealDeadlineAt, nowMs) : null;
  return (
    <li className={`line-row${job.band === 'revealed' ? ' called' : ''}`}>
      <span className="line-pos num" aria-label={`Position ${job.position ?? ''}`}>{job.position ?? '·'}</span>
      <div className="line-main">
        <strong>{studentLabel(job)}</strong>
        <span className="line-file" title={job.file.originalName}>{job.file.originalName}</span>
        <span className="line-specs">{specsSummary(job)}</span>
      </div>
      <span className="line-amount num">{rupees(job.totalPaise)}</span>
      <div className="line-side">
        {cd && (
          <span className={`line-timer num${cd.urgent ? ' urgent' : ''}`} role="timer" aria-label={`${cd.text} left to reach the counter`}>
            {cd.expired ? 'Time up' : `${cd.text} left`}
          </span>
        )}
        {!job.assignedPrinterId && <span className="badge warn" title="No online printer can print this yet. It will be offered a printer when you enter the code.">No printer yet</span>}
        {onAbsent && <button type="button" className="quiet danger-text" onClick={() => onAbsent(job)}>Mark absent</button>}
      </div>
    </li>
  );
}

export function LinePanel({ groups, capacity, loading, onAbsent }: { groups: LineGroups; capacity: number | null; loading: boolean; onAbsent: (job: QueueJob) => void }) {
  // ticks every second only while a called student has a timer, and only re-renders the line
  const nowMs = useNow(groups.atCounter.some((j) => j.revealDeadlineAt));
  const total = groups.atCounter.length + groups.comingUp.length + groups.waiting.length;
  const section = (title: string, list: QueueJob[], note: string | null, absent: boolean) => list.length > 0 && (
    <div className="line-group">
      <h3>{title}{note && <span className="line-note">{note}</span>}</h3>
      <ul className="line-list">
        {list.map((job) => <LineRow key={job.id} job={job} nowMs={nowMs} onAbsent={absent ? onAbsent : undefined} />)}
      </ul>
    </div>
  );
  return (
    <section className="line-panel" aria-labelledby="line-title">
      <div className="panel-head">
        <h2 id="line-title">Walk-in line</h2>
        {!loading && <span className="count" aria-label={`${total} checked in`}>{total}</span>}
      </div>
      {loading ? (
        <div className="skeleton-list" aria-hidden><div className="skeleton-card" /><div className="skeleton-card" /></div>
      ) : total === 0 ? (
        <p className="panel-empty">No one is waiting. Students join the line when they tap “I’m here” at your shop.</p>
      ) : (
        <>
          {section('At the counter', groups.atCounter, capacity ? `${groups.atCounter.length} of ${capacity} called` : null, true)}
          {section('Coming up', groups.comingUp, null, false)}
          {section('Waiting', groups.waiting, null, false)}
        </>
      )}
    </section>
  );
}

export function PreparedPanel({ jobs }: { jobs: QueueJob[] }) {
  const list = preparedJobs(jobs);
  if (list.length === 0) return null;
  return (
    <details className="disclosure prepared-panel">
      <summary>Ordered, not here yet <span className="count">{list.length}</span></summary>
      <p className="panel-help">These students have not checked in. Their code still finds the order if they are at the counter.</p>
      <ul className="line-list">
        {list.map((job) => (
          <li key={job.id} className="line-row prepared">
            <span className="line-when">{job.scheduledTime ? slotLabel(job.scheduledTime) : 'Any time'}</span>
            <div className="line-main">
              <strong>{studentLabel(job)}</strong>
              <span className="line-file" title={job.file.originalName}>{job.file.originalName}</span>
              <span className="line-specs">{specsSummary(job)}</span>
            </div>
            <span className="line-amount num">{rupees(job.totalPaise)}</span>
            <div className="line-side">{job.absent && <span className="badge danger">Missed turn</span>}</div>
          </li>
        ))}
      </ul>
    </details>
  );
}
