import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getToken, rupees } from '../../api.js';
import { getShopSocket } from '../../socket.js';
import { flashTitle, playChime } from '../../newOrderAlert.js';
import ShopNav from '../../components/ShopNav.js';

interface QueueJob {
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
  paymentStatus: 'pending' | 'cash_due' | 'paid' | 'refunding' | 'refunded' | 'failed';
  paymentProvider: string | null;
  cashCollectedAt: string | null;
  assignedPrinterId: string | null;
  otpExpiresAt: string | null;
  printError: string | null;
  printAttempts: number;
  queuedAt: string | null;
  arrivedAt: string | null;
  checkInCount: number;
  createdAt: string;
  student: { name: string | null; phoneMasked: string };
  file: { originalName: string; pages: number | null };
}

interface Printer {
  id: string;
  label: string;
  status: string;
}

interface ManualAssign {
  jobId?: string;
  eligiblePrinters: { printerId: string; estimatedWaitMinutes: number }[];
  overrideQueue: boolean;
}

interface QueueOverride {
  jobId?: string;
  position: number | null;
  queueStatus: string;
}

interface CashConfirmation {
  jobId?: string;
  amountPaise: number;
  selectedPrinterId?: string;
  overrideQueue: boolean;
}

interface SetupStatus {
  ready: boolean;
  printerReady: boolean;
  agentReady: boolean;
  acceptingOrders: boolean;
}

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export default function Dashboard() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [otp, setOtp] = useState('');
  const [manual, setManual] = useState<ManualAssign | null>(null);
  const [queueOverride, setQueueOverride] = useState<QueueOverride | null>(null);
  const [cashConfirmation, setCashConfirmation] = useState<CashConfirmation | null>(null);
  const [manualPrinter, setManualPrinter] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const seenWaitingIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [queueRes, printersRes, setupRes] = await Promise.all([
        api<{ jobs: QueueJob[] }>('/api/shop/queue', { role: 'shop' }),
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
        api<{ setup: SetupStatus }>('/api/shop/setup-status', { role: 'shop' }),
      ]);
      setJobs(queueRes.jobs);
      setPrinters(printersRes.printers);
      setSetup(setupRes.setup);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate('/dashboard/login');
      else setError(err instanceof Error ? err.message : 'Failed to load');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    void refresh();
  }, [refresh, navigate]);

  // beep + flash the tab title when a job the dashboard hasn't seen yet joins the live queue
  useEffect(() => {
    const waitingIds = new Set(jobs.filter((j) => j.status === 'queued' || j.status === 'notified').map((j) => j.id));
    if (seenWaitingIds.current) {
      const isNew = [...waitingIds].some((id) => !seenWaitingIds.current!.has(id));
      if (isNew) {
        playChime();
        if (document.hidden) flashTitle('🔔 New print job — PrintQ');
      }
    }
    seenWaitingIds.current = waitingIds;
  }, [jobs]);

  useEffect(() => {
    const socket = getShopSocket();
    if (!socket) return;
    const onAny = () => void refresh();
    const onPrintFailed = (p: { jobId: string; reason: string }) => {
      setError(`Print failed: ${p.reason}. Check the printer, then use Retry print below.`);
      void refresh();
    };
    const onNoAgent = () => {
      setError('No print agent is running for that printer — start the agent on the shop PC.');
    };
    socket.on('queue:update', onAny);
    socket.on('queue:job_printing', onAny);
    socket.on('queue:finishing_required', onAny);
    socket.on('queue:job_ready', onAny);
    socket.on('queue:manual_assign_needed', onAny);
    socket.on('agent:offline', onAny);
    socket.on('queue:print_failed', onPrintFailed);
    socket.on('queue:no_agent', onNoAgent);
    return () => {
      socket.off('queue:update', onAny);
      socket.off('queue:job_printing', onAny);
      socket.off('queue:finishing_required', onAny);
      socket.off('queue:job_ready', onAny);
      socket.off('queue:manual_assign_needed', onAny);
      socket.off('agent:offline', onAny);
      socket.off('queue:print_failed', onPrintFailed);
      socket.off('queue:no_agent', onNoAgent);
    };
  }, [refresh]);

  async function release(printerId?: string, overrideQueue = false, cashReceived = false) {
    setError('');
    setMessage('');
    try {
      const res = await api<{
        ok?: boolean;
        requiresManualAssignment?: boolean;
        requiresQueueOverride?: boolean;
        requiresCashConfirmation?: boolean;
        cashAmountPaise?: number;
        selectedPrinterId?: string;
        jobId?: string;
        position?: number | null;
        queueStatus?: string;
        eligiblePrinters?: { printerId: string; estimatedWaitMinutes: number }[];
      }>('/api/shop/release', {
        method: 'POST',
        role: 'shop',
        body: {
          otp,
          ...(printerId ? { printerId } : {}),
          overrideQueue,
          cashReceived,
        },
      });
      if (res.requiresQueueOverride) {
        setCashConfirmation(null);
        setQueueOverride({
          jobId: res.jobId,
          position: res.position ?? null,
          queueStatus: res.queueStatus ?? 'outside_queue',
        });
        return;
      }
      if (res.requiresManualAssignment) {
        setCashConfirmation(null);
        setManual({ jobId: res.jobId, eligiblePrinters: res.eligiblePrinters ?? [], overrideQueue });
        setManualPrinter(res.eligiblePrinters?.[0]?.printerId ?? '');
        return;
      }
      if (res.requiresCashConfirmation && res.cashAmountPaise != null) {
        setManual(null);
        setQueueOverride(null);
        setCashConfirmation({
          jobId: res.jobId,
          amountPaise: res.cashAmountPaise,
          selectedPrinterId: res.selectedPrinterId,
          overrideQueue,
        });
        return;
      }
      setMessage('Sent to printer ✓');
      setOtp('');
      setManual(null);
      setQueueOverride(null);
      setCashConfirmation(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release failed');
    }
  }

  async function jobAction(id: string, action: 'no-show' | 'handover') {
    if (action === 'no-show' && !confirm('Remove this student from the live line? Their prepared order stays available by counter code, but a later check-in will place them at the end.')) return;
    setError('');
    try {
      await api(`/api/shop/jobs/${id}/${action}`, { method: 'POST', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  async function retryPrint(id: string) {
    setError('');
    setMessage('');
    try {
      await api(`/api/shop/jobs/${id}/retry-print`, { method: 'POST', role: 'shop', body: {} });
      setMessage('Print sent again');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not retry this print');
    }
  }

  async function returnCashAndClose(id: string, amountPaise: number) {
    if (!confirm(`Only continue after returning ${rupees(amountPaise)} in cash to the student. Close this order?`)) return;
    setError('');
    setMessage('');
    try {
      await api(`/api/shop/jobs/${id}/cash-returned`, { method: 'POST', role: 'shop' });
      setMessage('Cash return recorded — order closed');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not close this cash order');
    }
  }

  async function completeFinishing(id: string) {
    setError('');
    setMessage('');
    try {
      await api(`/api/shop/jobs/${id}/finishing-complete`, { method: 'POST', role: 'shop' });
      setMessage('Finishing complete — student notified ✓');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete finishing');
    }
  }

  async function toggleAvailability() {
    if (!setup) return;
    const next = !setup.acceptingOrders;
    if (!next && !confirm('Pause new student orders? Existing prepared orders and counter codes will continue to work.')) return;
    setError('');
    try {
      await api('/api/shop/availability', {
        method: 'PATCH',
        role: 'shop',
        body: { acceptingOrders: next },
      });
      setMessage(next ? 'Storefront reopened' : 'New orders paused');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change storefront availability');
    }
  }

  const printerLabel = (id: string | null) =>
    id ? (printers.find((p) => p.id === id)?.label ?? id.slice(0, 8)) : '—';

  const specsText = (j: QueueJob) =>
    `${j.specs.copies}× ${j.specs.paperSize} ${j.specs.color ? 'colour' : 'B/W'}` +
    `${j.specs.duplex ? ' · 2-side' : ''}` +
    `${j.specs.binding ? ` · ${j.specs.binding.replace('_', ' ')}` : ''}` +
    `${j.specs.pageRange ? ` · p${j.specs.pageRange}` : ''} · ${j.pagesPerCopy}pp`;

  const prepared = jobs.filter((j) => j.status === 'awaiting_arrival');
  const waiting = jobs.filter((j) => j.status === 'queued' || j.status === 'notified');
  const inFlight = jobs.filter((j) => ['otp_verified', 'printing', 'finishing', 'ready_for_pickup'].includes(j.status));

  return (
    <div className="page wide shop-page">
      <ShopNav />

      <header className="page-heading dashboard-heading">
        <div>
          <span className="eyebrow-label">Live operations</span>
          <h1>Counter &amp; walk-in line</h1>
          <p>Queue positions organize students; the six-digit code always controls which prepared order prints.</p>
        </div>
        <div className="queue-summary">
          <span><strong>{waiting.length}</strong> waiting</span>
          <span><strong>{prepared.length}</strong> prepared remotely</span>
          <span><strong>{inFlight.length}</strong> printing / pickup</span>
          {setup && (
            <button className={setup.acceptingOrders ? 'ghost small' : 'small'} onClick={toggleAvailability}>
              {setup.acceptingOrders ? 'Pause new orders' : 'Reopen storefront'}
            </button>
          )}
        </div>
      </header>

      {setup && !setup.ready && (
        <div className="notice setup-notice">
          <div>
            <strong>Finish setup before accepting student orders</strong>
            <p>
              {!setup.agentReady ? 'Connect the counter PC and agent. ' : ''}
              {!setup.printerReady ? 'Link at least one online printer.' : ''}
            </p>
          </div>
          <button onClick={() => navigate('/dashboard/setup')}>Continue setup</button>
        </div>
      )}

      <div className="release-panel">
        <div>
          <span className="eyebrow-label">Counter action</span>
          <h2>Find order by counter code</h2>
          <p>
            Enter the student’s six-digit code to find the correct document. Codes unlock automatically near the front; staff can explicitly override the advisory line when a real counter situation requires it.
          </p>
        </div>
        <div className="release-controls">
          <input
            className="big-otp-input"
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="······"
            aria-label="Student's counter code"
            value={otp}
            onChange={(e) => {
              setOtp(e.target.value.replace(/\D/g, ''));
              setQueueOverride(null);
              setManual(null);
              setCashConfirmation(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && otp.length === 6 && void release()}
          />
          <button disabled={otp.length !== 6} onClick={() => release()}>
            Find &amp; print
          </button>
          {message && <span className="stamp green">{message}</span>}
        </div>
        {queueOverride && (
          <div className="manual-picker queue-override-panel" role="alert">
            <strong>This student is not currently called</strong>
            <p>
              {queueOverride.position !== null
                ? `Their live position is #${queueOverride.position}. Printing now will serve them out of turn.`
                : queueOverride.queueStatus === 'awaiting_arrival'
                  ? 'They have not checked in to the physical line.'
                  : 'They are not currently in the live line.'}
            </p>
            <div className="row">
              <button onClick={() => release(undefined, true)}>Print anyway</button>
              <button className="ghost" onClick={() => setQueueOverride(null)}>Keep queue order</button>
            </div>
          </div>
        )}
        {manual && (
          <div className="manual-picker">
            <strong>Choose a compatible printer</strong>
            <p>The recommended option has the shortest estimated completion time.</p>
            <div className="row">
              <select
                value={manualPrinter}
                onChange={(e) => setManualPrinter(e.target.value)}
                style={{ maxWidth: 340 }}
              >
                {manual.eligiblePrinters.length === 0 && <option value="">No eligible printer online!</option>}
                {manual.eligiblePrinters.map((p, i) => (
                  <option key={p.printerId} value={p.printerId}>
                    {printerLabel(p.printerId)} — ~{p.estimatedWaitMinutes} min{i === 0 ? ' (recommended)' : ''}
                  </option>
                ))}
              </select>
              <button disabled={!manualPrinter} onClick={() => release(manualPrinter, manual.overrideQueue)}>
                Confirm &amp; print
              </button>
              <button className="ghost" onClick={() => setManual(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {cashConfirmation && (
          <div className="manual-picker cash-confirm-panel" role="alert">
            <span className="eyebrow-label">Cash order</span>
            <strong>Collect {rupees(cashConfirmation.amountPaise)}</strong>
            <p>Count the cash first. This confirmation records the payment and sends the exact order to the printer.</p>
            <div className="row">
              <button onClick={() => release(cashConfirmation.selectedPrinterId, cashConfirmation.overrideQueue, true)}>
                Cash received &amp; print
              </button>
              <button className="ghost" onClick={() => setCashConfirmation(null)}>Not received</button>
            </div>
          </div>
        )}
        {error && <div className="error-box">{error}</div>}
      </div>

      <div className="section-heading"><div><h2>Physically checked in</h2><p>One shop-wide walk-in line, ordered by arrival. Serve the student who is actually at the counter.</p></div><span className="summary-pill">{waiting.length}</span></div>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>#</th><th>Student</th><th>File</th><th>Specs</th><th>Printer</th><th>Status</th><th>Amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            {waiting.length === 0 && (
              <tr><td colSpan={8}><div className="table-empty"><strong>No one is checked in</strong><span>Remote uploads stay out of this line until a student confirms arrival.</span></div></td></tr>
            )}
            {waiting.map((j, index) => (
              <tr key={j.id}>
                <td><strong>{index + 1}</strong></td>
                <td>{j.student.name ?? j.student.phoneMasked}</td>
                <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.file.originalName}
                </td>
                <td>{specsText(j)}</td>
                <td>
                  {printerLabel(j.assignedPrinterId)}{' '}
                  {!j.assignedPrinterId && <span className="stamp yellow">assign</span>}
                </td>
                <td>
                  <span className="stamp blue">checked in</span>
                  {j.paymentStatus === 'cash_due' && <span className="stamp yellow" style={{ marginLeft: 6 }}>cash due</span>}
                </td>
                <td className="mono">{rupees(j.totalPaise)}</td>
                <td>
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    <button className="ghost small" onClick={() => jobAction(j.id, 'no-show')}>
                      Remove from line
                    </button>
                    {!j.assignedPrinterId && (
                      <AssignButton jobId={j.id} printers={printers} onDone={refresh} />
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {prepared.length > 0 && (
        <>
          <div className="section-heading"><div><h2>Prepared, not checked in</h2><p>Remote orders are ready to find by code but do not occupy the physical line.</p></div><span className="summary-pill">{prepared.length}</span></div>
          <div className="table-shell">
            <table>
              <thead>
                <tr><th>Arrival plan</th><th>Student</th><th>File</th><th>Specs</th><th>Status</th></tr>
              </thead>
              <tbody>
                {prepared
                  .slice()
                  .sort((a, b) => new Date(a.scheduledTime ?? a.createdAt).getTime() - new Date(b.scheduledTime ?? b.createdAt).getTime())
                  .map((j) => (
                    <tr key={j.id}>
                      <td className="slot">{j.scheduledTime ? slotLabel(j.scheduledTime) : 'Flexible'}</td>
                      <td>{j.student.name ?? j.student.phoneMasked}</td>
                      <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.file.originalName}
                      </td>
                      <td>{specsText(j)}</td>
                      <td>
                        <span className="stamp yellow">awaiting arrival</span>
                        {j.paymentStatus === 'cash_due' && <span className="stamp yellow" style={{ marginLeft: 6 }}>cash due</span>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="section-heading"><div><h2>Printing and pickup</h2><p>Jobs released at the counter.</p></div><span className="summary-pill">{inFlight.length}</span></div>
      <div className="table-shell">
        <table>
          <thead>
            <tr><th>Student</th><th>File</th><th>Printer</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {inFlight.length === 0 && (
              <tr><td colSpan={5}><div className="table-empty"><strong>No active prints</strong><span>Verified jobs move here while the agent is working.</span></div></td></tr>
            )}
            {inFlight.map((j) => (
              <tr key={j.id}>
                <td>{j.student.name ?? j.student.phoneMasked}</td>
                <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.file.originalName}
                </td>
                <td>{printerLabel(j.assignedPrinterId)}</td>
                <td>
                  <span className={`stamp ${j.status === 'ready_for_pickup' ? 'green' : j.status === 'finishing' ? 'yellow' : 'blue'}`}>
                    {j.printError ? 'Needs attention' : j.status === 'finishing' ? 'manual finishing' : j.status.replace(/_/g, ' ')}
                  </span>
                  {j.printError && <div className="print-error-detail">{j.printError}</div>}
                </td>
                <td>
                  {j.status === 'otp_verified' && j.printError && (
                    <span className="row" style={{ flexWrap: 'nowrap' }}>
                      <button className="small" onClick={() => retryPrint(j.id)}>
                        Retry print
                      </button>
                      {j.paymentProvider === 'cash' && j.cashCollectedAt && (
                        <button className="ghost small" onClick={() => returnCashAndClose(j.id, j.totalPaise)}>
                          Cash returned
                        </button>
                      )}
                    </span>
                  )}
                  {j.status === 'finishing' && (
                    <button className="small" onClick={() => completeFinishing(j.id)}>
                      Mark {j.specs.binding?.replace('_', ' ') ?? 'finishing'} complete
                    </button>
                  )}
                  {j.status === 'ready_for_pickup' && (
                    <button className="small" onClick={() => jobAction(j.id, 'handover')}>
                      Handed over
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AssignButton({
  jobId,
  printers,
  onDone,
}: {
  jobId: string;
  printers: Printer[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState('');

  async function assign() {
    await api(`/api/shop/jobs/${jobId}/assign`, {
      method: 'POST',
      role: 'shop',
      body: { printerId: choice },
    }).catch(() => undefined);
    setOpen(false);
    onDone();
  }

  if (!open) {
    return (
      <button className="small" onClick={() => setOpen(true)}>
        Assign
      </button>
    );
  }
  return (
    <span className="row" style={{ flexWrap: 'nowrap' }}>
      <select value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Pick…</option>
        {printers
          .filter((p) => p.status === 'online')
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
      </select>
      <button className="small" disabled={!choice} onClick={assign}>
        OK
      </button>
    </span>
  );
}
