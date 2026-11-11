import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ago, api, ApiError, clearToken, getToken } from '../../api.js';
import Topbar from '../../components/Topbar.js';
import { formatRupees } from '../../lib/fees.js';
import { createLatestRequest } from '../../lib/latestRequest.js';
import {
  auditLabel, auditReason, campusErrorMessage, campusFormProblem, SHOP_STATE_LABELS, setupMissing, type ShopState,
} from './adminText.js';
import '../../shop.css';

interface Campus {
  id: string;
  name: string;
  address: string;
  isActive: boolean;
  _count: { shops: number };
}
type ShopView = 'all' | 'live' | 'hidden' | 'setup';
interface AdminShop {
  id: string;
  slug: string;
  name: string;
  address: string;
  createdAt: string;
  autoLive: boolean;
  publishedAt: string | null;
  state: ShopState;
  hiddenReason: string | null;
  campus: { name: string; isActive: boolean } | null;
  owner: { name: string; email: string } | null;
  setup: { location: boolean; printerLinked: boolean; pcOnline: boolean; pcCount: number };
  lastHeartbeatAt: string | null;
  feeBlockedAt: string | null;
  fees: { state: 'paid_up' | 'due' | 'overdue' | 'blocked'; statementsDuePaise: number; overdueStatements: number; overduePaise: number };
}
interface ShopPage {
  shops: AdminShop[];
  counts: Record<ShopView, number>;
  nextCursor: string | null;
}
interface AuditEvent {
  id: string;
  action: string;
  subjectType: string;
  subjectName: string | null;
  metadata: unknown;
  createdAt: string;
  admin: { name: string };
}
type Section = 'shops' | 'fees' | 'campuses' | 'events';

const TABS: { view: ShopView; label: string }[] = [
  { view: 'all', label: 'All' },
  { view: 'live', label: 'Live' },
  { view: 'hidden', label: 'Hidden' },
  { view: 'setup', label: 'Setting up' },
];

const isUnauthorized = (err: unknown) => (err as { status?: number } | null)?.status === 401;
/** Show the server's own sentence for a refusal (409), never a raw 500, validation or network error. */
function actionMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 409) return err.message;
  if (err instanceof ApiError && err.status === 404) return 'This shop no longer exists. Refresh the page.';
  return fallback;
}

function pcStatus(shop: AdminShop): string {
  if (shop.setup.pcCount === 0) return 'No PC connected yet';
  if (shop.setup.pcOnline) return shop.lastHeartbeatAt ? `PC online · checked in ${ago(shop.lastHeartbeatAt)}` : 'PC online';
  return shop.lastHeartbeatAt ? `PC offline · last seen ${ago(shop.lastHeartbeatAt)}` : 'PC offline · never connected';
}

function LoadError({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className="row between" role="alert">
      <span className="danger-text">Could not load {what}. Check your connection and try again.</span>
      <button className="secondary small" onClick={onRetry}>Try again</button>
    </div>
  );
}

export default function AdminConsole() {
  const navigate = useNavigate();
  const [view, setView] = useState<ShopView>('all');
  const [page, setPage] = useState<ShopPage | null>(null);
  const [feeShops, setFeeShops] = useState<AdminShop[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [failed, setFailed] = useState<Record<Section, boolean>>({ shops: false, fees: false, campuses: false, events: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [campusName, setCampusName] = useState('');
  const [campusAddress, setCampusAddress] = useState('');
  const [campusError, setCampusError] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; address: string } | null>(null);
  const [unpublishing, setUnpublishing] = useState<{ id: string; reason: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const shopRequest = useRef(createLatestRequest());

  const markFailed = (section: Section, value: boolean) => setFailed((prev) => ({ ...prev, [section]: value }));

  const loadShops = useCallback(async (shopView: ShopView, cursor?: string) => {
    const ticket = shopRequest.current.begin();
    const query = `view=${shopView}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    try {
      const result = await api<ShopPage>(`/api/admin/shops?${query}`, { role: 'admin', signal: ticket.signal });
      if (!ticket.isCurrent()) return;
      setPage((prev) => (cursor && prev ? { ...result, shops: [...prev.shops, ...result.shops] } : result));
      markFailed('shops', false);
    } catch (err) {
      if (!ticket.isCurrent()) return;
      if (isUnauthorized(err)) navigate('/admin/login', { replace: true });
      else markFailed('shops', true);
    }
  }, [navigate]);

  // Each section loads on its own: one failure shows an error there, never a false "all clear".
  const loadOthers = useCallback(async () => {
    const [fees, campusResult, eventResult] = await Promise.allSettled([
      api<{ shops: AdminShop[] }>('/api/admin/shops?view=fees', { role: 'admin' }),
      api<{ campuses: Campus[] }>('/api/admin/campuses', { role: 'admin' }),
      api<{ events: AuditEvent[] }>('/api/admin/audit-events?limit=12', { role: 'admin' }),
    ]);
    if ([fees, campusResult, eventResult].some((r) => r.status === 'rejected' && isUnauthorized(r.reason))) {
      navigate('/admin/login', { replace: true });
      return;
    }
    if (fees.status === 'fulfilled') setFeeShops(fees.value.shops);
    if (campusResult.status === 'fulfilled') setCampuses(campusResult.value.campuses);
    if (eventResult.status === 'fulfilled') setEvents(eventResult.value.events);
    setFailed((prev) => ({
      ...prev,
      fees: fees.status === 'rejected',
      campuses: campusResult.status === 'rejected',
      events: eventResult.status === 'rejected',
    }));
  }, [navigate]);

  const refresh = useCallback(() => Promise.all([loadShops(view), loadOthers()]), [loadShops, loadOthers, view]);

  useEffect(() => {
    if (!getToken('admin')) {
      navigate('/admin/login', { replace: true });
      return;
    }
    void loadOthers();
  }, [navigate, loadOthers]);

  useEffect(() => {
    if (getToken('admin')) void loadShops(view);
  }, [loadShops, view]);

  async function runAction(id: string, label: string, request: () => Promise<unknown>, fallback: string) {
    setBusyId(`${label}:${id}`);
    setError('');
    try {
      await request();
      await refresh();
      return true;
    } catch (err) {
      if (isUnauthorized(err)) navigate('/admin/login', { replace: true });
      else setError(actionMessage(err, fallback));
      return false;
    } finally {
      setBusyId(null);
    }
  }

  function changeShop(id: string, action: 'verify' | 'reject' | 'publish') {
    void runAction(id, action, () => api(`/api/admin/shops/${id}/${action}`, { method: 'POST', role: 'admin', body: {} }), 'The shop could not be changed. Please try again.');
  }

  async function confirmUnpublish() {
    if (!unpublishing) return;
    const { id, reason } = unpublishing;
    const done = await runAction(id, 'unpublish', () => api(`/api/admin/shops/${id}/unpublish`, {
      method: 'POST', role: 'admin', body: reason.trim() ? { reason: reason.trim() } : {},
    }), 'The shop could not be unpublished. Please try again.');
    if (done) setUnpublishing(null);
  }

  async function liftBlock(shop: AdminShop) {
    const reason = window.prompt(`Why is the fee block on ${shop.name} being lifted? (required, at least 10 characters, audited)`);
    if (!reason || reason.trim().length < 10) return;
    await runAction(shop.id, 'lift', () => api(`/api/admin/shops/${shop.id}/fees/lift-block`, {
      method: 'POST', role: 'admin', body: { reason: reason.trim(), days: 3 },
    }), 'The block could not be lifted. Please try again.');
  }

  async function saveCampus(request: () => Promise<unknown>) {
    setCampusError('');
    try {
      await request();
      await loadOthers();
      return true;
    } catch (err) {
      if (isUnauthorized(err)) navigate('/admin/login', { replace: true });
      else setCampusError(campusErrorMessage(err));
      return false;
    }
  }

  async function createCampus(event: React.FormEvent) {
    event.preventDefault();
    const problem = campusFormProblem(campusName, campusAddress);
    if (problem) return setCampusError(problem);
    const saved = await saveCampus(() => api('/api/admin/campuses', {
      method: 'POST', role: 'admin', body: { name: campusName.trim(), address: campusAddress.trim() },
    }));
    if (saved) {
      setCampusName('');
      setCampusAddress('');
    }
  }

  async function updateCampus(event: React.FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const problem = campusFormProblem(editing.name, editing.address);
    if (problem) return setCampusError(problem);
    const saved = await saveCampus(() => api(`/api/admin/campuses/${editing.id}`, {
      method: 'PATCH', role: 'admin', body: { name: editing.name.trim(), address: editing.address.trim() },
    }));
    if (saved) setEditing(null);
  }

  async function toggleCampus(campus: Campus) {
    if (campus.isActive && !window.confirm(`Deactivate ${campus.name}? It disappears from the campus list, and its ${campus._count.shops} shop(s) are hidden from students until you activate it again.`)) return;
    setBusyId(`campus:${campus.id}`);
    await saveCampus(() => api(`/api/admin/campuses/${campus.id}`, { method: 'PATCH', role: 'admin', body: { isActive: !campus.isActive } }));
    setBusyId(null);
    // Shops on this campus change visibility too.
    void loadShops(view);
  }

  async function signOut() {
    try {
      await api('/api/admin/auth/logout', { method: 'POST', role: 'admin' });
    } catch {
      /* offline or already expired — local sign-out still proceeds */
    }
    clearToken('admin');
    navigate('/admin/login', { replace: true });
  }

  function shopDetail(shop: AdminShop): string | null {
    if (shop.state === 'live') return shop.publishedAt ? `Live since ${ago(shop.publishedAt)}` : null;
    if (shop.state === 'hidden_by_admin') return shop.hiddenReason ? `Reason: ${shop.hiddenReason}` : 'Not visible to students.';
    if (shop.state === 'campus_inactive') return `${shop.campus?.name ?? 'Its campus'} is inactive, so students cannot see this shop.`;
    if (shop.state === 'setting_up') {
      const missing = setupMissing(shop.setup);
      if (missing) return `Still needs: ${missing}`;
      return shop.autoLive ? 'Setup looks complete. It goes live on the next PC check-in.' : 'Older shop: needs a manual review.';
    }
    if (shop.state === 'waiting_review') return 'Asked for a review.';
    return null;
  }

  const busy = busyId != null;
  const shops = page?.shops ?? [];

  return (
    <main className="page wide shop-page">
      <Topbar />
      <header className="page-heading">
        <div><span className="eyebrow-label">Platform operations</span><h1>Campus &amp; shop review</h1><p>A shop goes live in student discovery by itself once its setup is complete. You can unpublish any shop that should not appear.</p></div>
        <button className="ghost small admin-signout" onClick={signOut}>Sign out</button>
      </header>
      {error && <div className="error-box" role="alert">{error}</div>}

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Shops</h2><p>Every registered shop, newest first. Use this to spot fake shops and help owners stuck in setup.</p></div>
        <div className="settings-surface stack">
          <div className="segmented admin-tabs" role="group" aria-label="Filter shops">
            {TABS.map((tab) => (
              <button key={tab.view} type="button" className={view === tab.view ? 'active' : ''} aria-pressed={view === tab.view} onClick={() => { setUnpublishing(null); setView(tab.view); }}>
                {tab.label} <span className="admin-tab-count">{page ? page.counts[tab.view] : '…'}</span>
              </button>
            ))}
          </div>
          {failed.shops ? <LoadError what="shops" onRetry={() => void loadShops(view)} />
            : !page ? <p className="dim">Loading shops…</p>
            : shops.length === 0 ? <p className="dim">No shops in this list.</p>
            : shops.map((shop) => {
              const label = SHOP_STATE_LABELS[shop.state];
              const detail = shopDetail(shop);
              const confirming = unpublishing?.id === shop.id;
              return (
                <div className="admin-shop" key={shop.id}>
                  <div className="row between">
                    <div className="admin-shop-info">
                      <div className="row">
                        <strong>{shop.name}</strong>
                        <span className={`stamp ${label.tone}`}>{label.text}</span>
                        {/* almost every shop goes live by itself: badge only the exception */}
                        {!shop.autoLive && <span className="stamp yellow" title="Older shop that needs a manual review before it is listed">Manual review</span>}
                      </div>
                      <p className="dim">{shop.owner ? <>{shop.owner.name} · <a href={`mailto:${shop.owner.email}`}>{shop.owner.email}</a></> : 'No owner account'} · <span title={new Date(shop.createdAt).toLocaleString()}>joined {ago(shop.createdAt)}</span></p>
                      <p className="dim">{shop.campus ? `${shop.campus.name} · ` : ''}{shop.address} · {pcStatus(shop)}</p>
                      {detail && <p className="dim">{detail}{shop.state === 'live' && <> · <a href={`/s/${shop.slug}`} target="_blank" rel="noreferrer">Open student page</a></>}</p>}
                    </div>
                    <div className="row">
                      {(shop.state === 'live' || shop.state === 'campus_inactive') && !confirming && (
                        <button className="secondary small" disabled={busy} onClick={() => setUnpublishing({ id: shop.id, reason: '' })}>Unpublish</button>
                      )}
                      {shop.state === 'hidden_by_admin' && (
                        <button className="button-link small" disabled={busy || shop.campus?.isActive === false} title={shop.campus?.isActive === false ? 'Activate its campus first' : undefined} onClick={() => changeShop(shop.id, 'publish')}>{busyId === `publish:${shop.id}` ? 'Publishing…' : 'Publish'}</button>
                      )}
                      {shop.state === 'waiting_review' && <>
                        <button className="secondary small" disabled={busy} onClick={() => changeShop(shop.id, 'reject')}>Reject</button>
                        <button className="button-link small" disabled={busy} onClick={() => changeShop(shop.id, 'verify')}>{busyId === `verify:${shop.id}` ? 'Verifying…' : 'Verify'}</button>
                      </>}
                    </div>
                  </div>
                  {confirming && (
                    <div className="admin-confirm">
                      <label htmlFor={`unpublish-reason-${shop.id}`}>Why are you hiding {shop.name}? (optional)</label>
                      <input id={`unpublish-reason-${shop.id}`} value={unpublishing.reason} maxLength={500} placeholder="e.g. Fake shop, reported by students" onChange={(event) => setUnpublishing({ id: shop.id, reason: event.target.value })} autoFocus />
                      <p className="dim">Students stop seeing this shop right away. You can publish it again later. The reason is saved in the decision trail.</p>
                      <div className="row">
                        <button className="secondary small" disabled={busy} onClick={() => setUnpublishing(null)}>Keep it live</button>
                        <button className="danger small" disabled={busy} onClick={() => void confirmUnpublish()}>{busyId === `unpublish:${shop.id}` ? 'Unpublishing…' : 'Unpublish'}</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          {page?.nextCursor && !failed.shops && (
            <button className="secondary small" disabled={loadingMore} onClick={async () => {
              setLoadingMore(true);
              await loadShops(view, page.nextCursor ?? undefined);
              setLoadingMore(false);
            }}>{loadingMore ? 'Loading…' : `Show more (${shops.length} of ${page.counts[view]})`}</button>
          )}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Platform fees</h2><p>Unpaid weekly fees pause new orders. A lift keeps the shop open for 3 days and does not forgive the statement.</p></div>
        <div className="settings-surface stack">
          {failed.fees ? <LoadError what="fees" onRetry={() => void loadOthers()} />
            : feeShops.length === 0 ? <p className="dim">Every shop is paid up.</p>
            : feeShops.map((shop) => (
              <div className="row between" key={shop.id}>
                <div><strong>{shop.name}</strong><p className="dim">{formatRupees(shop.fees.statementsDuePaise)} on statements{shop.fees.overdueStatements > 0 ? ` · ${shop.fees.overdueStatements} overdue (${formatRupees(shop.fees.overduePaise)})` : ''}</p></div>
                <div className="row">
                  <span className={`stamp ${shop.fees.state === 'due' ? 'yellow' : 'red'}`}>{shop.fees.state}</span>
                  {shop.feeBlockedAt && <button className="secondary small" disabled={busy} onClick={() => liftBlock(shop)}>Lift block</button>}
                </div>
              </div>
            ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Campus catalogue</h2><p>Optional: campuses help students find nearby shops, but a shop does not need one to go live. Deactivating a campus hides its shops.</p></div>
        <div className="settings-surface stack">
          <form className="form-row" onSubmit={createCampus} noValidate>
            <div className="field grow"><label htmlFor="campus-name">Campus name</label><input id="campus-name" value={campusName} maxLength={160} onChange={(event) => setCampusName(event.target.value)} /></div>
            <div className="field grow"><label htmlFor="campus-address">Address</label><input id="campus-address" value={campusAddress} maxLength={300} onChange={(event) => setCampusAddress(event.target.value)} /></div>
            <div className="field"><label>&nbsp;</label><button className="secondary" type="submit">Add campus</button></div>
          </form>
          {campusError && !editing && <p className="danger-text" role="alert">{campusError}</p>}
          {failed.campuses ? <LoadError what="campuses" onRetry={() => void loadOthers()} />
            : campuses.map((campus) => editing?.id === campus.id ? (
              <form className="form-row admin-campus-edit" key={campus.id} onSubmit={updateCampus} noValidate>
                <div className="field grow"><label htmlFor="edit-campus-name">Campus name</label><input id="edit-campus-name" value={editing.name} maxLength={160} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></div>
                <div className="field grow"><label htmlFor="edit-campus-address">Address</label><input id="edit-campus-address" value={editing.address} maxLength={300} onChange={(event) => setEditing({ ...editing, address: event.target.value })} /></div>
                <div className="field"><label>&nbsp;</label><div className="row"><button className="secondary small" type="button" onClick={() => { setEditing(null); setCampusError(''); }}>Cancel</button><button className="button-link small" type="submit">Save</button></div></div>
                {campusError && <p className="danger-text admin-campus-error" role="alert">{campusError}</p>}
              </form>
            ) : (
              <div className="row between" key={campus.id}>
                <span><strong>{campus.name}</strong> <span className="dim">· {campus.address} · {campus._count.shops} shops</span></span>
                <div className="row">
                  <span className={`stamp ${campus.isActive ? 'green' : 'yellow'}`}>{campus.isActive ? 'active' : 'inactive'}</span>
                  <button className="text-button" type="button" disabled={busy} onClick={() => { setCampusError(''); setEditing({ id: campus.id, name: campus.name, address: campus.address }); }}>Edit</button>
                  <button className="secondary small" type="button" disabled={busy} onClick={() => void toggleCampus(campus)}>{busyId === `campus:${campus.id}` ? 'Saving…' : campus.isActive ? 'Deactivate' : 'Activate'}</button>
                </div>
              </div>
            ))}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-copy"><h2>Decision trail</h2><p>Every decision made from this console, with who made it and when. Shops that go live by themselves are not listed here; older shops that need a manual review carry a badge under Shops.</p></div>
        <div className="settings-surface stack">
          {failed.events ? <LoadError what="the decision trail" onRetry={() => void loadOthers()} />
            : events.length === 0 ? <p className="dim">No decisions have been recorded yet.</p>
            : events.map((event) => {
              const reason = auditReason(event);
              return (
                <div className="row between" key={event.id}>
                  <span><strong>{auditLabel(event)}</strong>{event.subjectName && <span> · {event.subjectName}</span>}{reason && <span className="dim"> · “{reason}”</span>}</span>
                  <span className="dim">{event.admin.name} · {new Date(event.createdAt).toLocaleString()}</span>
                </div>
              );
            })}
        </div>
      </section>
    </main>
  );
}
