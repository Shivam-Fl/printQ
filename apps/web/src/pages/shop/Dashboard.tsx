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
  assignedPrinterId: string | null;
  otpExpiresAt: string | null;
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
}

const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

export default function Dashboard() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [otp, setOtp] = useState('');
  const [manual, setManual] = useState<ManualAssign | null>(null);
  const [manualPrinter, setManualPrinter] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const seenWaitingIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [queueRes, printersRes] = await Promise.all([
        api<{ jobs: QueueJob[] }>('/api/shop/queue', { role: 'shop' }),
        api<{ printers: Printer[] }>('/api/shop/printers', { role: 'shop' }),
      ]);
      setJobs(queueRes.jobs);
      setPrinters(printersRes.printers);
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
      setError(`Print failed (${p.reason}). Check the printer, then enter the OTP again.`);
      void refresh();
    };
    const onNoAgent = () => {
      setError('No print agent is running for that printer — start the agent on the shop PC.');
    };
    socket.on('queue:update', onAny);
    socket.on('queue:job_printing', onAny);
    socket.on('queue:job_ready', onAny);
    socket.on('queue:manual_assign_needed', onAny);
    socket.on('agent:offline', onAny);
    socket.on('queue:print_failed', onPrintFailed);
    socket.on('queue:no_agent', onNoAgent);
    return () => {
      socket.off('queue:update', onAny);
      socket.off('queue:job_printing', onAny);
      socket.off('queue:job_ready', onAny);
      socket.off('queue:manual_assign_needed', onAny);
      socket.off('agent:offline', onAny);
      socket.off('queue:print_failed', onPrintFailed);
      socket.off('queue:no_agent', onNoAgent);
    };
  }, [refresh]);

  async function release(printerId?: string) {
    setError('');
    setMessage('');
    try {
      const res = await api<{
        ok?: boolean;
        requiresManualAssignment?: boolean;
        jobId?: string;
        eligiblePrinters?: { printerId: string; estimatedWaitMinutes: number }[];
      }>('/api/shop/release', {
        method: 'POST',
        role: 'shop',
        body: printerId ? { otp, printerId } : { otp },
      });
      if (res.requiresManualAssignment) {
        setManual({ jobId: res.jobId, eligiblePrinters: res.eligiblePrinters ?? [] });
        setManualPrinter(res.eligiblePrinters?.[0]?.printerId ?? '');
        return;
      }
      setMessage('Sent to printer ✓');
      setOtp('');
      setManual(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Release failed');
    }
  }

  async function jobAction(id: string, action: 'no-show' | 'handover') {
    setError('');
    try {
      await api(`/api/shop/jobs/${id}/${action}`, { method: 'POST', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    }
  }

  const printerLabel = (id: string | null) =>
    id ? (printers.find((p) => p.id === id)?.label ?? id.slice(0, 8)) : '—';

  const specsText = (j: QueueJob) =>
    `${j.specs.copies}× ${j.specs.paperSize} ${j.specs.color ? 'colour' : 'B/W'}` +
    `${j.specs.duplex ? ' · 2-side' : ''}` +
    `${j.specs.binding ? ` · ${j.specs.binding.replace('_', ' ')}` : ''}` +
    `${j.specs.pageRange ? ` · p${j.specs.pageRange}` : ''} · ${j.pagesPerCopy}pp`;

  const now = Date.now();
  const isPendingSlot = (j: QueueJob) =>
    j.mode === 'scheduled' && j.scheduledTime && new Date(j.scheduledTime).getTime() - 10 * 60_000 > now;

  const waiting = jobs.filter((j) => (j.status === 'queued' && !isPendingSlot(j)) || j.status === 'notified');
  const slots = jobs.filter((j) => j.status === 'queued' && isPendingSlot(j));
  const inFlight = jobs.filter((j) => ['otp_verified', 'printing', 'ready_for_pickup'].includes(j.status));

  return (
    <div className="page wide">
      <ShopNav />

      <div className="card stack">
        <div>
          <h2 style={{ margin: '0 0 2px' }}>Release a print</h2>
          <p className="dim" style={{ margin: 0 }}>
            Type the student's code — the job prints itself.
          </p>
        </div>
        <div className="row">
          <input
            className="big-otp-input"
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="······"
            aria-label="Student's OTP"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && otp.length === 6 && void release()}
            style={{ maxWidth: 240 }}
          />
          <button disabled={otp.length !== 6} onClick={() => release()}>
            Verify &amp; print
          </button>
          {message && <span className="stamp green">{message}</span>}
        </div>
        {manual && (
          <div className="stack" style={{ borderTop: '2px dashed var(--rule)', paddingTop: 12 }}>
            <span className="stamp yellow">pick a printer for this job</span>
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
              <button disabled={!manualPrinter} onClick={() => release(manualPrinter)}>
                Confirm &amp; print
              </button>
              <button className="ghost" onClick={() => setManual(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </div>

      <h2>Waiting ({waiting.length})</h2>
      <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
        <table>
          <thead>
            <tr>
              <th>Student</th><th>File</th><th>Specs</th><th>Printer</th><th>Status</th><th>Amount</th><th></th>
            </tr>
          </thead>
          <tbody>
            {waiting.length === 0 && (
              <tr><td colSpan={7} className="dim">Queue is empty</td></tr>
            )}
            {waiting.map((j) => (
              <tr key={j.id}>
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
                  <span className={`stamp ${j.status === 'notified' ? 'yellow' : 'blue'}`}>
                    {j.status === 'notified' ? 'otp sent' : j.mode === 'scheduled' ? 'slot due' : 'queued'}
                  </span>
                </td>
                <td className="mono">{rupees(j.totalPaise)}</td>
                <td>
                  <span className="row" style={{ flexWrap: 'nowrap' }}>
                    {j.status === 'notified' && (
                      <button className="ghost small" onClick={() => jobAction(j.id, 'no-show')}>
                        No-show
                      </button>
                    )}
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

      {slots.length > 0 && (
        <>
          <h2>Booked slots ({slots.length})</h2>
          <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
            <table>
              <thead>
                <tr><th>Slot</th><th>Student</th><th>File</th><th>Specs</th><th>Printer</th></tr>
              </thead>
              <tbody>
                {slots
                  .slice()
                  .sort((a, b) => new Date(a.scheduledTime!).getTime() - new Date(b.scheduledTime!).getTime())
                  .map((j) => (
                    <tr key={j.id}>
                      <td className="slot">{slotLabel(j.scheduledTime!)}</td>
                      <td>{j.student.name ?? j.student.phoneMasked}</td>
                      <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {j.file.originalName}
                      </td>
                      <td>{specsText(j)}</td>
                      <td>{printerLabel(j.assignedPrinterId)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>Printing &amp; pickup ({inFlight.length})</h2>
      <div className="card" style={{ overflowX: 'auto', padding: 6 }}>
        <table>
          <thead>
            <tr><th>Student</th><th>File</th><th>Printer</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {inFlight.length === 0 && (
              <tr><td colSpan={5} className="dim">Nothing printing right now</td></tr>
            )}
            {inFlight.map((j) => (
              <tr key={j.id}>
                <td>{j.student.name ?? j.student.phoneMasked}</td>
                <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {j.file.originalName}
                </td>
                <td>{printerLabel(j.assignedPrinterId)}</td>
                <td>
                  <span className={`stamp ${j.status === 'ready_for_pickup' ? 'green' : 'blue'}`}>
                    {j.status.replace(/_/g, ' ')}
                  </span>
                </td>
                <td>
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
