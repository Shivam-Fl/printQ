import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api, getShopRole, getToken } from '../../api.js';
import { statusBanner } from '../../lib/setupSteps.js';
import { shopStatus, type ShopSetupStatus } from '../../lib/shopStatus.js';
import { getShopSocket } from '../../socket.js';
import { flashTitle, playChime } from '../../newOrderAlert.js';
import ShopNav from '../../components/ShopNav.js';
import { shopLoginPath } from '../../lib/locationFlow.js';
import CounterCode, { type PrinterLite } from './CounterCode.js';
import { InFlightPanel, LinePanel, PreparedPanel } from './CounterLists.js';
import { inFlightJobs, lineGroups, studentLabel, type QueueJob } from './counterFlow.js';

interface ShopMe {
  shop: { counterUpiVpa: string | null; counterUpiVerifiedAt: string | null };
  user: { role: 'owner' | 'staff' };
}

/** The counter: one code box, what is printing, and the walk-in line. */
export default function Dashboard() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<QueueJob[]>([]);
  const [capacity, setCapacity] = useState<number | null>(null);
  const [printers, setPrinters] = useState<PrinterLite[]>([]);
  const [setup, setSetup] = useState<ShopSetupStatus | null>(shopStatus.get());
  const [upiReady, setUpiReady] = useState(false);
  const [isOwner, setIsOwner] = useState(getShopRole() !== 'staff');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [alert, setAlert] = useState('');
  const [receipt, setReceipt] = useState<{ text: string; key: number } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const seenWaitingIds = useRef<Set<string> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [queueRes, printersRes, setupRes] = await Promise.all([
        api<{ jobs: QueueJob[]; counterCapacity: number }>('/api/shop/queue', { role: 'shop' }),
        api<{ printers: PrinterLite[] }>('/api/shop/printers', { role: 'shop' }),
        api<{ setup: ShopSetupStatus }>('/api/shop/setup-status', { role: 'shop' }),
      ]);
      setJobs(queueRes.jobs);
      setCapacity(queueRes.counterCapacity);
      setPrinters(printersRes.printers);
      setSetup(setupRes.setup);
      shopStatus.set(setupRes.setup);
      setLoadError('');
      setLoaded(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate(shopLoginPath());
      else setLoadError(err instanceof Error ? err.message : 'Could not load the counter.');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(shopLoginPath());
      return;
    }
    void refresh();
    api<ShopMe>('/api/shop/me', { role: 'shop' })
      .then((me) => {
        setUpiReady(Boolean(me.shop.counterUpiVpa && me.shop.counterUpiVerifiedAt));
        setIsOwner(me.user.role === 'owner');
      })
      .catch(() => undefined);
  }, [refresh, navigate]);

  // a new student in the line: chime, and flash the tab title when the counter is in the background
  useEffect(() => {
    const waitingIds = new Set(jobs.filter((j) => j.status === 'queued' || j.status === 'notified').map((j) => j.id));
    if (seenWaitingIds.current && [...waitingIds].some((id) => !seenWaitingIds.current!.has(id))) {
      playChime();
      if (document.hidden) flashTitle('New student in line · PrintQs');
    }
    seenWaitingIds.current = waitingIds;
  }, [jobs]);

  useEffect(() => {
    const socket = getShopSocket();
    if (!socket) return;
    const onAny = () => void refresh();
    const onPrintFailed = (p: { jobId: string; message?: string }) => {
      setAlert(p.message ?? 'A print hit a problem. Check the printer, then press Retry print.');
      void refresh();
    };
    const onNoAgent = () => setAlert('No counter PC is running for that printer. Open PrintQs Shop on the counter PC.');
    const events = ['queue:update', 'queue:job_printing', 'queue:finishing_required', 'queue:job_ready', 'queue:print_confirmation_required', 'queue:manual_assign_needed', 'agent:offline'];
    for (const e of events) socket.on(e, onAny);
    socket.on('queue:print_failed', onPrintFailed);
    socket.on('queue:no_agent', onNoAgent);
    return () => {
      for (const e of events) socket.off(e, onAny);
      socket.off('queue:print_failed', onPrintFailed);
      socket.off('queue:no_agent', onNoAgent);
    };
  }, [refresh]);

  // the "Sent to…" line fades after a few seconds
  useEffect(() => {
    if (!receipt) return;
    const timer = setTimeout(() => setReceipt(null), 8000);
    return () => clearTimeout(timer);
  }, [receipt]);

  const done = useCallback((text: string) => {
    setReceipt({ text, key: Date.now() });
    setAlert('');
    setFocusSignal((n) => n + 1); // back to the code box for the next student
    void refresh();
  }, [refresh]);

  async function markAbsent(job: QueueJob) {
    if (!confirm(`Mark ${studentLabel(job)} absent? They lose their place and must check in again at the back. Their order and code still work.`)) return;
    try {
      await api(`/api/shop/jobs/${job.id}/no-show`, { method: 'POST', role: 'shop' });
      done(`${studentLabel(job)} marked absent`);
    } catch (err) {
      setAlert(err instanceof Error ? err.message : 'Could not mark absent. Try again.');
    }
  }

  async function setAccepting(next: boolean) {
    if (!next && !confirm('Pause new orders? Students see your shop as closed. Orders already placed and their codes keep working.')) return;
    try {
      await api('/api/shop/availability', { method: 'PATCH', role: 'shop', body: { acceptingOrders: next } });
      setReceipt({ text: next ? 'New orders are on again' : 'New orders paused', key: Date.now() });
      await refresh();
    } catch (err) {
      setAlert(err instanceof Error ? err.message : 'Could not change new orders. Try again.');
    }
  }

  const groups = useMemo(() => lineGroups(jobs), [jobs]);
  const inFlight = useMemo(() => inFlightJobs(jobs), [jobs]);
  const banner = setup ? statusBanner(setup) : null;
  const paused = setup?.acceptingOrders === false;

  return (
    <div className="page wide shop-page counter-page">
      <ShopNav />

      <div className="counter-head">
        <h1>Counter</h1>
        <div className="counter-head-side">
          {receipt && <p key={receipt.key} className="counter-receipt" role="status">{receipt.text}</p>}
          {setup && !paused && (
            <button type="button" className="secondary small" onClick={() => void setAccepting(false)}>Pause new orders</button>
          )}
        </div>
      </div>

      {paused && (
        <div className="notice warn counter-notice" role="status">
          <div>
            <strong>New orders are paused</strong>
            <p>Students see your shop as closed. Orders already placed and their codes still work.</p>
          </div>
          <button type="button" onClick={() => void setAccepting(true)}>Resume new orders</button>
        </div>
      )}
      {banner && (
        <div className="notice warn counter-notice">
          <div>
            <strong>{banner.title}</strong>
            <p>{banner.text}</p>
          </div>
          <Link className="button-link secondary" to={banner.to}>{banner.action}</Link>
        </div>
      )}
      {loadError && (
        <div className="notice danger counter-notice" role="alert">
          <div>
            <strong>Can’t load the counter</strong>
            <p>{loadError}</p>
          </div>
          <button type="button" className="secondary" onClick={() => void refresh()}>Try again</button>
        </div>
      )}
      {alert && (
        <div className="notice danger counter-notice" role="alert">
          <div><strong>{alert}</strong></div>
          <button type="button" className="quiet" onClick={() => setAlert('')}>Dismiss</button>
        </div>
      )}

      <div className="counter-grid">
        <CounterCode
          jobs={jobs}
          printers={printers}
          upiReady={upiReady}
          isOwner={isOwner}
          reload={refresh}
          onSent={(r) => done(r.text)}
          focusSignal={focusSignal}
        />
        <InFlightPanel jobs={inFlight} printers={printers} loading={!loaded} onDone={done} />
        <LinePanel groups={groups} capacity={capacity} loading={!loaded} onAbsent={(job) => void markAbsent(job)} />
        <PreparedPanel jobs={jobs} />
      </div>

      <details className="disclosure counter-help">
        <summary>How the counter works</summary>
        <ul>
          <li>The student shows a 6-digit code. Type it: the order, amount and printer appear.</li>
          <li>Take the money, then press <strong>Cash received &amp; print</strong> or <strong>UPI received &amp; print</strong>.</li>
          <li>When the pages come out, check them and press <strong>Printed OK · hand over</strong>.</li>
          <li>Students “At the counter” must reach you before their timer ends, or they are marked absent and check in again. Typing their code stops the timer.</li>
          <li>You can serve someone out of turn; the counter asks you first and keeps a record.</li>
        </ul>
      </details>
    </div>
  );
}
