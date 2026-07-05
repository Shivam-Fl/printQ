import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, clearToken, getToken, rupees } from '../../api.js';
import { getShopSocket, resetSockets } from '../../socket.js';

interface QueueJob {
  id: string;
  status: string;
  specs: { copies: number; paperSize: string; color: boolean; duplex: boolean; binding: string | null; pageRange: string | null };
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

export default function Dashboard() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [printers, setPrinters] = useState<Printer[]>([]);
  const [otp, setOtp] = useState('');
  const [manual, setManual] = useState<ManualAssign | null>(null);
  const [manualPrinter, setManualPrinter] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

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

  useEffect(() => {
    const socket = getShopSocket();
    if (!socket) return;
    const onAny = () => void refresh();
    socket.on('queue:update', onAny);
    socket.on('queue:job_printing', onAny);
    socket.on('queue:job_ready', onAny);
    socket.on('queue:manual_assign_needed', onAny);
    const onPrintFailed = (p: { jobId: string; reason: string }) => {
      setError(`Print failed for job ${p.jobId.slice(0, 8)}: ${p.reason}. Enter the OTP again or check the printer.`);
      void refresh();
    };
    const onNoAgent = (p: { printerId: string }) => {
      setError(`No print agent is running for printer ${p.printerId.slice(0, 8)} — start the agent PC.`);
    };
    socket.on('queue:print_failed', onPrintFailed);
    socket.on('queue:no_agent', onNoAgent);
    socket.on('agent:offline', onAny);
    return () => {
      socket.off('queue:update', onAny);
      socket.off('queue:job_printing', onAny);
      socket.off('queue:job_ready', onAny);
      socket.off('queue:manual_assign_needed', onAny);
      socket.off('queue:print_failed', onPrintFailed);
      socket.off('queue:no_agent', onNoAgent);
      socket.off('agent:offline', onAny);
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
      setMessage('Print released ✓');
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

  const waiting = jobs.filter((j) => j.status === 'queued' || j.status === 'notified');
  const inFlight = jobs.filter((j) => ['otp_verified', 'printing', 'ready_for_pickup'].includes(j.status));

  return (
    <div className="page wide">
      <div className="topbar">
        <span className="brand">PrintQ · Dashboard</span>
        <div className="row">
          <Link to="/dashboard/printers">Printers</Link>
          <Link to="/dashboard/agents">Agents</Link>
          <button
            className="ghost small"
            onClick={() => {
              clearToken('shop');
              resetSockets();
              navigate('/dashboard/login');
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="card stack">
        <h2 style={{ margin: 0 }}>Release a print</h2>
        <div className="row">
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="Student's OTP"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && otp.length === 6 && void release()}
            style={{ maxWidth: 220, fontSize: '1.3rem', letterSpacing: '0.2em' }}
          />
          <button disabled={otp.length !== 6} onClick={() => release()}>
            Verify &amp; print
          </button>
        </div>
        {manual && (
          <div className="stack" style={{ borderTop: '1px solid #2a333d', paddingTop: 10 }}>
            <span className="badge warn">Pick a printer for this job</span>
            <div className="row">
              <select value={manualPrinter} onChange={(e) => setManualPrinter(e.target.value)} style={{ maxWidth: 320 }}>
                {manual.eligiblePrinters.length === 0 && <option value="">No eligible printer online!</option>}
                {manual.eligiblePrinters.map((p, i) => (
                  <option key={p.printerId} value={p.printerId}>
                    {printerLabel(p.printerId)} — ~{p.estimatedWaitMinutes} min{i === 0 ? ' (recommended)' : ''}
                  </option>
                ))}
              </select>
              <button disabled={!manualPrinter} onClick={() => release(manualPrinter)}>Confirm &amp; print</button>
              <button className="ghost" onClick={() => setManual(null)}>Cancel</button>
            </div>
          </div>
        )}
        {message && <span className="badge ok">{message}</span>}
        {error && <div className="error">{error}</div>}
      </div>

      <h2>Waiting ({waiting.length})</h2>
      <div className="card" style={{ overflowX: 'auto', padding: 8 }}>
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
                <td>{j.file.originalName}</td>
                <td>
                  {j.specs.copies}× {j.specs.paperSize} {j.specs.color ? 'colour' : 'B/W'}
                  {j.specs.duplex ? ' · duplex' : ''}
                  {j.specs.binding ? ` · ${j.specs.binding.replace('_', ' ')}` : ''}
                  {j.specs.pageRange ? ` · p${j.specs.pageRange}` : ''} · {j.pagesPerCopy}pp
                </td>
                <td>{printerLabel(j.assignedPrinterId)}{!j.assignedPrinterId && <span className="badge warn">assign!</span>}</td>
                <td>
                  <span className={`badge ${j.status === 'notified' ? 'ok' : 'accent'}`}>
                    {j.status === 'notified' ? 'OTP sent' : 'queued'}
                  </span>
                </td>
                <td>{rupees(j.totalPaise)}</td>
                <td>
                  {j.status === 'notified' && (
                    <button className="ghost small" onClick={() => jobAction(j.id, 'no-show')}>No-show</button>
                  )}
                  {!j.assignedPrinterId && <AssignButton jobId={j.id} printers={printers} onDone={refresh} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Printing &amp; pickup ({inFlight.length})</h2>
      <div className="card" style={{ overflowX: 'auto', padding: 8 }}>
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
                <td>{j.file.originalName}</td>
                <td>{printerLabel(j.assignedPrinterId)}</td>
                <td><span className="badge accent">{j.status.replace(/_/g, ' ')}</span></td>
                <td>
                  {j.status === 'ready_for_pickup' && (
                    <button className="small" onClick={() => jobAction(j.id, 'handover')}>Handed over</button>
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

function AssignButton({ jobId, printers, onDone }: { jobId: string; printers: Printer[]; onDone: () => void }) {
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
    return <button className="small" onClick={() => setOpen(true)}>Assign</button>;
  }
  return (
    <span className="row">
      <select value={choice} onChange={(e) => setChoice(e.target.value)}>
        <option value="">Pick…</option>
        {printers.filter((p) => p.status === 'online').map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <button className="small" disabled={!choice} onClick={assign}>OK</button>
    </span>
  );
}
