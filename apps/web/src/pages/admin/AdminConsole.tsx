import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken, getToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';
import { formatRupees } from '../../lib/fees.js';

interface Campus {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
  _count: { shops: number };
}
interface ReviewShop {
  id: string;
  name: string;
  address: string;
  verificationStatus: 'draft' | 'submitted' | 'verified' | 'rejected';
  verificationSubmittedAt: string | null;
  publishedAt: string | null;
  campus: { name: string; isActive: boolean } | null;
  printers: { id: string; status: string; osPrinterName: string | null }[];
  agents: { id: string; status: string }[];
  feeBlockedAt: string | null;
  fees: { state: 'paid_up' | 'due' | 'overdue' | 'blocked'; statementsDuePaise: number; overdueStatements: number; overduePaise: number };
}
interface AuditEvent {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string;
  createdAt: string;
  admin: { name: string };
}

export default function AdminConsole() {
  const navigate = useNavigate();
  const [shops, setShops] = useState<ReviewShop[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [campusName, setCampusName] = useState('');
  const [campusAddress, setCampusAddress] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [shopResult, campusResult, eventResult] = await Promise.all([
        api<{ shops: ReviewShop[] }>('/api/admin/shops', { role: 'admin' }),
        api<{ campuses: Campus[] }>('/api/admin/campuses', { role: 'admin' }),
        api<{ events: AuditEvent[] }>('/api/admin/audit-events?limit=12', { role: 'admin' }),
      ]);
      setShops(shopResult.shops);
      setCampuses(campusResult.campuses);
      setEvents(eventResult.events);
    } catch (err) {
      if ((err as { status?: number }).status === 401) navigate('/admin/login', { replace: true });
      else setError(err instanceof Error ? err.message : 'Could not load operations data.');
    }
  }, [navigate]);

  useEffect(() => {
    if (!getToken('admin')) {
      navigate('/admin/login', { replace: true });
      return;
    }
    void refresh();
  }, [navigate, refresh]);

  async function changeShop(id: string, action: 'verify' | 'reject' | 'publish' | 'unpublish') {
    setBusyId(`${action}:${id}`);
    setError('');
    try {
      await api(`/api/admin/shops/${id}/${action}`, { method: 'POST', role: 'admin', body: {} });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The shop state could not be changed.');
    } finally {
      setBusyId(null);
    }
  }

  async function liftBlock(shop: ReviewShop) {
    const reason = window.prompt(`Why is the fee block on ${shop.name} being lifted? (required, at least 10 characters, audited)`);
    if (!reason || reason.trim().length < 10) return;
    setBusyId(`lift:${shop.id}`);
    setError('');
    try {
      await api(`/api/admin/shops/${shop.id}/fees/lift-block`, { method: 'POST', role: 'admin', body: { reason: reason.trim(), days: 3 } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The block could not be lifted.');
    } finally {
      setBusyId(null);
    }
  }

  async function createCampus(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/admin/campuses', { method: 'POST', role: 'admin', body: { name: campusName, address: campusAddress } });
      setCampusName('');
      setCampusAddress('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The campus could not be created.');
    }
  }

  function signOut() {
    clearToken('admin');
    navigate('/admin/login', { replace: true });
  }

  const submitted = shops.filter((shop) => shop.verificationStatus === 'submitted');
  const verified = shops.filter((shop) => shop.verificationStatus === 'verified');

  return (
    <main className="page wide shop-page">
      <Topbar />
      <header className="page-heading">
        <div><span className="eyebrow-label">Platform operations</span><h1>Campus &amp; shop review</h1><p>A shop goes live in student discovery by itself once its setup is complete. You can unpublish any shop that should not appear.</p></div>
        <button className="ghost small" onClick={signOut}>Sign out</button>
      </header>
      {error && <div className="error-box">{error}</div>}

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Campus catalogue</h2><p>Optional: campuses help students find nearby shops, but a shop does not need one to go live.</p></div>
        <div className="settings-surface stack">
          <form className="form-row" onSubmit={createCampus}>
            <div className="field grow"><label htmlFor="campus-name">Campus name</label><input id="campus-name" value={campusName} onChange={(event) => setCampusName(event.target.value)} required /></div>
            <div className="field grow"><label htmlFor="campus-address">Address</label><input id="campus-address" value={campusAddress} onChange={(event) => setCampusAddress(event.target.value)} required /></div>
            <div className="field"><label>&nbsp;</label><button className="secondary" type="submit">Add campus</button></div>
          </form>
          {campuses.map((campus) => <div className="row between" key={campus.id}><span><strong>{campus.name}</strong> <span className="dim">· {campus.address} · {campus._count.shops} shops</span></span><span className={`stamp ${campus.isActive ? 'green' : 'yellow'}`}>{campus.isActive ? 'active' : 'inactive'}</span></div>)}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Verification queue</h2><p>Review the physical counter setup before approving its public identity.</p></div>
        <div className="settings-surface stack">
          {submitted.length === 0 ? <p className="dim">No shops are waiting for verification.</p> : submitted.map((shop) => (
            <div className="row between" key={shop.id}>
              <div><strong>{shop.name}</strong><p className="dim">{shop.address} · {shop.campus?.name ?? 'No approved campus'} · {shop.printers.length} printers / {shop.agents.length} agents</p></div>
              <div className="row"><button className="secondary small" disabled={busyId != null} onClick={() => changeShop(shop.id, 'reject')}>Reject</button><button className="button-link small" disabled={busyId != null} onClick={() => changeShop(shop.id, 'verify')}>{busyId === `verify:${shop.id}` ? 'Verifying…' : 'Verify'}</button></div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Publication controls</h2><p>Verification and student visibility are intentionally separate decisions.</p></div>
        <div className="settings-surface stack">
          {verified.length === 0 ? <p className="dim">No verified shops are awaiting publication.</p> : verified.map((shop) => (
            <div className="row between" key={shop.id}>
              <div><strong>{shop.name}</strong><p className="dim">{shop.campus?.name ?? 'No approved campus'} · {shop.publishedAt ? 'Visible to students' : 'Hidden from students'}</p></div>
              {shop.publishedAt ? <button className="secondary small" disabled={busyId != null} onClick={() => changeShop(shop.id, 'unpublish')}>Unpublish</button> : <button className="button-link small" disabled={busyId != null} onClick={() => changeShop(shop.id, 'publish')}>Publish</button>}
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Platform fees</h2><p>Unpaid weekly fees pause new orders. A lift keeps the shop open for 3 days and does not forgive the statement.</p></div>
        <div className="settings-surface stack">
          {shops.filter((shop) => shop.fees.state !== 'paid_up').length === 0 ? <p className="dim">Every shop is paid up.</p> : shops.filter((shop) => shop.fees.state !== 'paid_up').map((shop) => (
            <div className="row between" key={shop.id}>
              <div><strong>{shop.name}</strong><p className="dim">{formatRupees(shop.fees.statementsDuePaise)} on statements{shop.fees.overdueStatements > 0 ? ` · ${shop.fees.overdueStatements} overdue (${formatRupees(shop.fees.overduePaise)})` : ''}</p></div>
              <div className="row">
                <span className={`stamp ${shop.fees.state === 'due' ? 'yellow' : 'red'}`}>{shop.fees.state}</span>
                {shop.feeBlockedAt && <button className="secondary small" disabled={busyId != null} onClick={() => liftBlock(shop)}>Lift block</button>}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Immutable decision trail</h2><p>Every campus, verification, and publication decision is recorded with its administrator and time.</p></div>
        <div className="settings-surface stack">
          {events.length === 0 ? <p className="dim">No operational decisions have been recorded yet.</p> : events.map((event) => <div className="row between" key={event.id}><span><strong>{event.action}</strong> <span className="dim">· {event.subjectType}</span></span><span className="dim">{event.admin.name} · {new Date(event.createdAt).toLocaleString()}</span></div>)}
        </div>
      </section>
    </main>
  );
}
