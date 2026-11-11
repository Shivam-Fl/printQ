import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MAX_BINDING_PRICE_PAISE, MAX_PAGE_PRICE_PAISE } from '@printq/shared';
import { api, ApiError, getShopRole, getToken } from '../../api.js';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import QueueSettings from '../../components/QueueSettings.js';
import ShopNav from '../../components/ShopNav.js';
import ShopTabs from '../../components/ShopTabs.js';
import ShopLocationEditor from '../../components/ShopLocationEditor.js';
import {
  buildSettingsPatch,
  colourPrinterWarning,
  locationChangeNeedsReview,
  coordinateWarning,
  formatRupeesField,
  markupPercent,
  parseRupees,
  priceText,
  studentPayText,
  typePrice,
  type OptionsDraft,
  type SettingsDraft,
} from './settingsForm.js';
import { shopLoginPath } from '../../lib/locationFlow.js';

/** Price inputs hold TEXT while editing; paise is derived on save (OWN-3). */
interface PaperRow {
  id: string;
  label: string;
  bw: string;
  color: string;
}
interface BindingRow {
  id: string;
  label: string;
  price: string;
}
interface Options {
  papers: PaperRow[];
  bindings: BindingRow[];
  duplexEnabled: boolean;
}
type StoredOptions = OptionsDraft;

const toRows = (stored: StoredOptions): Options => ({
  duplexEnabled: stored.duplexEnabled,
  papers: stored.papers.map((p) => ({ id: p.id, label: p.label, bw: priceText(p.bwPaise), color: priceText(p.colorPaise) })),
  bindings: stored.bindings.map((b) => ({ id: b.id, label: b.label, price: priceText(b.paise) })),
});

interface RowErrors {
  bw?: string;
  color?: string;
  price?: string;
}
function paperErrors(row: PaperRow): RowErrors {
  const bw = parseRupees(row.bw, { required: true, maxPaise: MAX_PAGE_PRICE_PAISE });
  const color = parseRupees(row.color, { required: false, maxPaise: MAX_PAGE_PRICE_PAISE });
  const errors: RowErrors = { bw: bw.error, color: color.error };
  if (!errors.bw && !errors.color && color.paise != null && bw.paise != null && color.paise < bw.paise) {
    errors.color = 'Colour price should not be lower than the B/W price';
  }
  return errors;
}
function bindingErrors(row: BindingRow): RowErrors {
  return { price: parseRupees(row.price, { required: true, maxPaise: MAX_BINDING_PRICE_PAISE }).error };
}
interface ShopProfile {
  name: string;
  address: string;
  campusName: string | null;
  campusId: string | null;
  campus: { id: string; name: string; slug: string } | null;
  slug: string;
  autoLive?: boolean;
  latitude: number | null;
  longitude: number | null;
  checkInRadiusM: number;
  counterCapacity: number;
  revealGraceSeconds: number;
  locationUpdatedAt: string | null;
  counterUpiVpa: string | null;
  counterUpiPayeeName: string | null;
  counterUpiVerifiedAt: string | null;
}
interface PrinterSummary {
  colorSupport: boolean;
  status: string;
  osPrinterName: string | null;
}
interface Campus {
  id: string;
  slug: string;
  name: string;
  address: string;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || `opt-${Date.now()}`;
/** A fresh id from the label that does not collide with ids already used. */
function uniqueId(label: string, taken: Set<string>): string {
  const base = slug(label);
  let id = base;
  for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base.slice(0, 36)}-${n}`;
  taken.add(id.toLowerCase());
  return id;
}

/** One component, two pages: /dashboard/prices (the print menu) and /dashboard/settings (everything else). Same save. */
export default function Settings({ section = 'shop' }: { section?: 'prices' | 'shop' }) {
  const navigate = useNavigate();
  const pricesPage = section === 'prices';
  const [opts, setOpts] = useState<Options | null>(null);
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [autoAssign, setAutoAssign] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [campuses, setCampuses] = useState<Campus[]>([]);
  // What the server last told us — saves send only the difference from this.
  const [baseline, setBaseline] = useState<{ draft: SettingsDraft; menuVersion: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [loadError, setLoadError] = useState('');
  // PrintQs fee on top of the shop's price, so the owner sees what students pay (M5)
  const [markupBps, setMarkupBps] = useState<number | null>(null);
  const [printers, setPrinters] = useState<PrinterSummary[] | null>(null);
  const location = useLocation();

  useEffect(() => {
    if (!getToken('shop')) {
      navigate(shopLoginPath());
      return;
    }
    // Only used for the colour-printer hint; the page works without it.
    api<{ printers: PrinterSummary[] }>('/api/shop/printers', { role: 'shop' })
      .then((result) => setPrinters(result.printers))
      .catch(() => setPrinters(null));
    Promise.all([
      api<{
        shop: ShopProfile & { printOptions: StoredOptions; printOptionsVersion: number; autoAssignEnabled: boolean };
        platformMarkupBps?: number;
      }>('/api/shop/me', { role: 'shop' }),
      api<{ campuses: Campus[] }>('/api/public/campuses'),
    ])
      .then(([r, campusResult]) => {
        const bps = r.platformMarkupBps;
        setMarkupBps(typeof bps === 'number' && Number.isInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : null);
        setLoadError('');
        setOpts(toRows(r.shop.printOptions));
        setBaseline({
          menuVersion: r.shop.printOptionsVersion,
          draft: {
            name: r.shop.name,
            address: r.shop.address,
            campusId: r.shop.campusId,
            latitude: r.shop.latitude,
            longitude: r.shop.longitude,
            checkInRadiusM: r.shop.checkInRadiusM,
            counterCapacity: r.shop.counterCapacity,
            revealGraceSeconds: r.shop.revealGraceSeconds,
            autoAssignEnabled: r.shop.autoAssignEnabled,
            counterUpiVpa: r.shop.counterUpiVpa,
            counterUpiPayeeName: r.shop.counterUpiPayeeName,
            printOptions: r.shop.printOptions,
          },
        });
        setConflict(false);
        setError('');
        setCampuses(campusResult.campuses);
        setProfile({
          name: r.shop.name,
          address: r.shop.address,
          campusName: r.shop.campusName,
          campusId: r.shop.campusId,
          campus: r.shop.campus,
          slug: r.shop.slug,
          autoLive: r.shop.autoLive,
          latitude: r.shop.latitude,
          longitude: r.shop.longitude,
          checkInRadiusM: r.shop.checkInRadiusM,
          counterCapacity: r.shop.counterCapacity,
          revealGraceSeconds: r.shop.revealGraceSeconds,
          locationUpdatedAt: r.shop.locationUpdatedAt,
          counterUpiVpa: r.shop.counterUpiVpa,
          counterUpiPayeeName: r.shop.counterUpiPayeeName,
          counterUpiVerifiedAt: r.shop.counterUpiVerifiedAt,
        });
        setAutoAssign(r.shop.autoAssignEnabled);
      })
      .catch((err) => {
        // Only a rejected session goes back to login; a blip or a cold start gets a retry.
        if (err instanceof ApiError && err.status === 401) navigate(shopLoginPath());
        else setLoadError('Could not reach PrintQs. Check the internet connection and try again.');
      });
  }, [navigate, reloadTick]);

  useEffect(() => {
    // Old links (emails, bookmarks) to the prices part of Settings now open the Prices page.
    if (!pricesPage && location.hash === '#prices') navigate('/dashboard/prices', { replace: true });
  }, [pricesPage, location.hash, navigate]);

  const retryLoad = () => {
    setLoadError('');
    setReloadTick((n) => n + 1);
  };

  const setPin = useCallback((latitude: number, longitude: number) => {
    setProfile((current) => current ? { ...current, latitude, longitude, locationUpdatedAt: new Date().toISOString() } : current);
    setError('');
  }, []);
  const setAddress = useCallback((address: string) => {
    setProfile((current) => current ? { ...current, address } : current);
  }, []);

  if (!opts) {
    return (
      <div className="page wide shop-page settings-page">
        <ShopNav />
        <ShopTabs />
        {loadError ? (
          <div className="empty-state" role="alert">
            <strong>Could not load your {pricesPage ? 'prices' : 'settings'}</strong>
            <p>{loadError}</p>
            <button type="button" className="secondary" style={{ marginTop: 14 }} onClick={retryLoad}>Try again</button>
          </div>
        ) : (
          <div className="skeleton-list" role="status" aria-label="Loading">
            <div className="skeleton-card" style={{ height: 120 }} />
            <div className="skeleton-card" style={{ height: 220 }} />
          </div>
        )}
      </div>
    );
  }

  const setPaper = (i: number, patch: Partial<PaperRow>) =>
    setOpts({ ...opts, papers: opts.papers.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  const setBinding = (i: number, patch: Partial<BindingRow>) =>
    setOpts({ ...opts, bindings: opts.bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  const priceErrorsPresent = opts.papers.some((p) => p.label.trim() && Object.values(paperErrors(p)).some(Boolean))
    || opts.bindings.some((b) => b.label.trim() && Object.values(bindingErrors(b)).some(Boolean));
  const locationHint = profile ? coordinateWarning(profile.latitude, profile.longitude) : null;
  const hasColourPrice = opts.papers.some((p) => {
    const colour = parseRupees(p.color, { required: false });
    return p.label.trim() && !colour.error && colour.paise != null;
  });
  const colourHint = printers ? colourPrinterWarning(hasColourPrice, printers) : null;

  async function save() {
    if (!opts || !profile) return;
    if ((profile.latitude == null) !== (profile.longitude == null)) {
      setError('Enter both latitude and longitude, or choose the entrance on the map.');
      return;
    }
    if (!baseline) return;
    // clean up: drop empty-label rows, give new rows unique ids, convert text -> paise
    const labelled = opts.papers.filter((p) => p.label.trim());
    if (labelled.length === 0) {
      setError('Add at least one paper type.');
      return;
    }
    if (priceErrorsPresent) {
      setError('Fix the highlighted prices before saving.');
      return;
    }
    // "none" is reserved: it is always offered implicitly as no binding.
    const taken = new Set(['none', ...labelled.map((p) => p.id), ...opts.bindings.filter((b) => b.label.trim()).map((b) => b.id)]
      .filter(Boolean).map((id) => id.toLowerCase()));
    const papers = labelled.map((p) => ({
      id: p.id || uniqueId(p.label, taken),
      label: p.label.trim(),
      bwPaise: parseRupees(p.bw, { required: true }).paise ?? 0,
      colorPaise: parseRupees(p.color, { required: false }).paise ?? null,
    }));
    const bindings = opts.bindings.filter((b) => b.label.trim()).map((b) => ({
      id: b.id || uniqueId(b.label, taken),
      label: b.label.trim(),
      paise: parseRupees(b.price, { required: true }).paise ?? 0,
    }));
    const draft: SettingsDraft = {
      name: profile.name,
      address: profile.address,
      campusId: profile.campusId,
      latitude: profile.latitude,
      longitude: profile.longitude,
      checkInRadiusM: profile.checkInRadiusM,
      counterCapacity: profile.counterCapacity,
      revealGraceSeconds: profile.revealGraceSeconds,
      autoAssignEnabled: autoAssign,
      counterUpiVpa: profile.counterUpiVpa,
      counterUpiPayeeName: profile.counterUpiPayeeName,
      printOptions: { papers, bindings, duplexEnabled: opts.duplexEnabled },
    };
    // Only what changed: re-sending untouched fields would unpublish a verified
    // shop and let a stale tab overwrite another tab's edits.
    const patch = buildSettingsPatch(baseline.draft, draft, baseline.menuVersion);
    if (profile.autoLive !== true && locationChangeNeedsReview(baseline.draft, draft)
      && !confirm('Moving your counter location sends your shop for re-review and hides it from students until approved. Continue?')) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (Object.keys(patch).length > 0) {
        const response = await api<{ shop: { printOptionsVersion: number } }>('/api/shop/me', {
          method: 'PATCH',
          role: 'shop',
          body: patch,
        });
        setBaseline({ draft, menuVersion: response.shop.printOptionsVersion });
      }
      setOpts(toRows(draft.printOptions));
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: string } | undefined)?.code === 'SETTINGS_CHANGED_ELSEWHERE') {
        setConflict(true);
      }
      setError(err instanceof Error ? err.message : 'Only the owner can change settings.');
    } finally {
      setSaving(false);
    }
  }

  async function verifyMerchantUpi() {
    if (!profile?.counterUpiVpa || !profile.counterUpiPayeeName) {
      setError('Save both the UPI ID and the payee name first.');
      return;
    }
    if (!confirm(`Check ${profile.counterUpiVpa} and “${profile.counterUpiPayeeName}” in the shop’s merchant app now. Continue only if they match exactly.`)) return;
    setSaving(true);
    setError('');
    try {
      const response = await api<{ counterUpi: Pick<ShopProfile, 'counterUpiVpa' | 'counterUpiPayeeName' | 'counterUpiVerifiedAt'> }>('/api/shop/counter-upi/verify', {
        method: 'POST',
        role: 'shop',
        body: { merchantAppChecked: true },
      });
      setProfile({ ...profile, ...response.counterUpi });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record the UPI check.');
    } finally {
      setSaving(false);
    }
  }

  const located = Boolean(profile && profile.latitude != null && profile.longitude != null);
  const SettingsBody = pricesPage ? 'form' : 'div';

  return (
    <div className="page wide shop-page settings-page">
      <ShopNav />
      <ShopTabs />
      <header className="page-heading">
        <div>
          <h1>{pricesPage ? 'Prices' : 'Settings'}</h1>
          <p>{pricesPage ? 'What you charge. Students see one price: yours plus the PrintQs fee.' : 'Your shop details, location, UPI and staff.'}</p>
        </div>
        {profile && <a className="text-link" href={`/s/${profile.slug}`} target="_blank" rel="noreferrer">See your student page</a>}
      </header>

      {/* Prices is a real form (Enter saves). Settings is not: the map's address search is its own form and forms cannot nest. */}
      {/* no onSubmit on the div: the address search inside it submits its own form and must not save the page */}
      <SettingsBody className="settings-form" {...(pricesPage ? { onSubmit: (event: FormEvent) => { event.preventDefault(); void save(); } } : {})}>
        {pricesPage ? (
          <>
            {markupBps ? (
              <p className="price-fee-note">
                Under each price you see what students pay: your price plus the {markupPercent(markupBps)} PrintQs fee. Students pay that full
                amount to you at the counter; the fee part is added to what you owe PrintQs (see Earnings).
              </p>
            ) : null}
            {colourHint && <p className="warn-note" role="status">{colourHint} <Link to="/dashboard/printers">Open printers</Link></p>}

            <section className="settings-block" aria-labelledby="paper-title">
              <div className="settings-block-head">
                <h2 id="paper-title">Paper</h2>
                <button type="button" className="secondary small" onClick={() => setOpts({ ...opts, papers: [...opts.papers, { id: '', label: '', bw: '2.00', color: '' }] })}>Add paper</button>
              </div>
              <p className="dim">Price per page. Leave colour empty if that paper is black &amp; white only.</p>
              <div className="opt-head" aria-hidden>
                <span>Paper</span><span>Black &amp; white</span><span>Colour</span><span></span>
              </div>
              {opts.papers.map((p, i) => {
                const errors = paperErrors(p);
                const bwPays = studentPayText(p.bw, markupBps);
                const colourPays = studentPayText(p.color, markupBps);
                const name = p.label || 'this paper';
                return (
                  <div key={i} className="opt-row priced-row paper-row">
                    <input type="text" aria-label="Paper name" placeholder="e.g. College sheet" value={p.label} onChange={(e) => setPaper(i, { label: e.target.value })} />
                    <div className="opt-price">
                      <span className="opt-price-label" aria-hidden>Black &amp; white, ₹ per page</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${name} black and white price per page`}
                        aria-invalid={Boolean(errors.bw)}
                        aria-describedby={bwPays ? `paper-${i}-bw-pays` : undefined}
                        value={p.bw}
                        onChange={(e) => setPaper(i, { bw: typePrice(p.bw, e.target.value) })}
                        onBlur={() => setPaper(i, { bw: formatRupeesField(p.bw) })}
                      />
                      {bwPays && <span className="student-pays" id={`paper-${i}-bw-pays`}>{bwPays}</span>}
                    </div>
                    <div className="opt-price">
                      <span className="opt-price-label" aria-hidden>Colour, ₹ per page</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${name} colour price per page`}
                        aria-invalid={Boolean(errors.color)}
                        aria-describedby={colourPays ? `paper-${i}-colour-pays` : undefined}
                        placeholder="No colour"
                        value={p.color}
                        onChange={(e) => setPaper(i, { color: typePrice(p.color, e.target.value) })}
                        onBlur={() => setPaper(i, { color: formatRupeesField(p.color) })}
                      />
                      {colourPays && <span className="student-pays" id={`paper-${i}-colour-pays`}>{colourPays}</span>}
                    </div>
                    <button type="button" className="rm" aria-label={`Remove ${name}`} title="Remove" onClick={() => setOpts({ ...opts, papers: opts.papers.filter((_, idx) => idx !== i) })}>×</button>
                    {(errors.bw || errors.color) && <p className="opt-error" role="alert">{errors.bw ?? errors.color}</p>}
                  </div>
                );
              })}
            </section>

            <section className="settings-block" aria-labelledby="binding-title">
              <div className="settings-block-head">
                <h2 id="binding-title">Binding and finishing</h2>
                <button type="button" className="secondary small" onClick={() => setOpts({ ...opts, bindings: [...opts.bindings, { id: '', label: '', price: '0.00' }] })}>Add binding</button>
              </div>
              <p className="dim">“None” is always offered. Price per order.</p>
              {opts.bindings.map((b, i) => {
                const errors = bindingErrors(b);
                const pays = studentPayText(b.price, markupBps);
                const name = b.label || 'this binding';
                return (
                  <div key={i} className="opt-row priced-row binding-row">
                    <input type="text" aria-label="Binding name" placeholder="e.g. Spiral binding" value={b.label} onChange={(e) => setBinding(i, { label: e.target.value })} />
                    <div className="opt-price">
                      <input
                        type="text"
                        inputMode="decimal"
                        aria-label={`${name} price`}
                        aria-invalid={Boolean(errors.price)}
                        aria-describedby={pays ? `binding-${i}-pays` : undefined}
                        value={b.price}
                        onChange={(e) => setBinding(i, { price: typePrice(b.price, e.target.value) })}
                        onBlur={() => setBinding(i, { price: formatRupeesField(b.price) })}
                      />
                      {pays && <span className="student-pays" id={`binding-${i}-pays`}>{pays}</span>}
                    </div>
                    <button type="button" className="rm" aria-label={`Remove ${name}`} title="Remove" onClick={() => setOpts({ ...opts, bindings: opts.bindings.filter((_, idx) => idx !== i) })}>×</button>
                    {errors.price && <p className="opt-error" role="alert">{errors.price}</p>}
                  </div>
                );
              })}
            </section>

            <section className="setting-row">
              <div>
                <strong>Double-sided printing</strong>
                <p className="dim">Let students choose one side or both sides.</p>
              </div>
              <button type="button" role="switch" aria-checked={opts.duplexEnabled} className={`toggle-button ${opts.duplexEnabled ? 'on' : ''}`} onClick={() => setOpts({ ...opts, duplexEnabled: !opts.duplexEnabled })}>
                <span aria-hidden /> {opts.duplexEnabled ? 'On' : 'Off'}
              </button>
            </section>
            <p className="dim settings-footnote">Students only see a paper or binding when an online printer can do it (set on the Printers page).</p>
          </>
        ) : profile && (
          <>
            <section className="settings-block" aria-labelledby="details-title">
              <h2 id="details-title">Shop details</h2>
              <div className="form-row">
                <div className="field grow"><label htmlFor="profile-name">Shop name</label><input id="profile-name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></div>
                <div className="field grow">
                  <label htmlFor="profile-campus">Campus <span className="optional-label">optional</span></label>
                  <select
                    id="profile-campus"
                    value={profile.campusId ?? ''}
                    onChange={(event) => {
                      const campus = campuses.find((item) => item.id === event.target.value) ?? null;
                      setProfile({ ...profile, campusId: campus?.id ?? null, campus, campusName: campus?.name ?? null });
                    }}
                  >
                    <option value="">Not on a campus</option>
                    {campuses.map((campus) => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="field"><label htmlFor="profile-address">Shop address</label><input id="profile-address" value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} /></div>
            </section>

            <section className="settings-block" aria-labelledby="location-title">
              <div className="settings-block-head">
                <h2 id="location-title">Location</h2>
                <span className={`badge ${located ? 'ok' : 'warn'}`}>{located ? 'Pin saved' : 'Pin needed'}</span>
              </div>
              <p className="dim">Students can join your line only when they are near this pin. PrintQs checks their location once and does not store it.</p>
              <ShopLocationEditor
                latitude={profile.latitude}
                longitude={profile.longitude}
                address={profile.address}
                onPin={setPin}
                onAddress={setAddress}
                hideAddress
              />
              {locationHint && <p className="warn-note" role="status">{locationHint}</p>}
            </section>

            <section className="settings-block" id="payments" aria-labelledby="upi-title">
              <div className="settings-block-head">
                <h2 id="upi-title">UPI at the counter</h2>
                <span className={`badge ${profile.counterUpiVerifiedAt ? 'ok' : 'warn'}`}>
                  {profile.counterUpiVerifiedAt ? `Checked ${new Date(profile.counterUpiVerifiedAt).toLocaleDateString()}` : 'Not checked yet'}
                </span>
              </div>
              <p className="dim">Needed for the “UPI received” button at the counter. A payment screen or screenshot is never proof: check your merchant app.</p>
              <div className="form-row">
                <div className="field grow"><label htmlFor="merchant-upi-vpa">Shop UPI ID</label><input id="merchant-upi-vpa" placeholder="shop@bank" value={profile.counterUpiVpa ?? ''} onChange={(event) => setProfile({ ...profile, counterUpiVpa: event.target.value || null, counterUpiVerifiedAt: null })} /></div>
                <div className="field grow"><label htmlFor="merchant-upi-payee">Name shown in your UPI app</label><input id="merchant-upi-payee" placeholder="Shop name as shown to payers" value={profile.counterUpiPayeeName ?? ''} onChange={(event) => setProfile({ ...profile, counterUpiPayeeName: event.target.value || null, counterUpiVerifiedAt: null })} /></div>
              </div>
              {!profile.counterUpiVerifiedAt && (
                <div className="row">
                  <button type="button" className="secondary small" disabled={saving || !profile.counterUpiVpa || !profile.counterUpiPayeeName} onClick={() => void verifyMerchantUpi()}>I checked it in my UPI app</button>
                  <span className="dim">Save first, then confirm the ID and name match your merchant app.</span>
                </div>
              )}
            </section>

            <details className="disclosure settings-advanced">
              <summary>Advanced</summary>
              <p className="dim">Good defaults are already set. Change these only if you need to.</p>
              <div className="settings-block">
                <h3>Students called to the counter</h3>
                <p className="dim">How many students see their code at once, and how long they get to reach the counter before they lose their place.</p>
                <QueueSettings
                  capacity={profile.counterCapacity}
                  graceSeconds={profile.revealGraceSeconds}
                  onChange={(next) => setProfile({ ...profile, ...next })}
                />
              </div>
              <div className="settings-block">
                <label htmlFor="check-in-radius">How close students must be to join the line</label>
                <select
                  id="check-in-radius"
                  value={profile.checkInRadiusM}
                  onChange={(event) => setProfile({ ...profile, checkInRadiusM: Number(event.target.value) })}
                >
                  {![20, 50, 100, 200].includes(profile.checkInRadiusM) && (
                    <option value={profile.checkInRadiusM}>{profile.checkInRadiusM} m (current)</option>
                  )}
                  <option value={20}>20 m: strict, right at the entrance</option>
                  <option value={50}>50 m: inside the shop</option>
                  <option value={100}>100 m: weak phone location indoors</option>
                  <option value={200}>200 m: recommended, next building or across the road</option>
                </select>
                <span className="field-help">A smaller distance stops check-ins from far away but needs a more accurate phone location.</span>
              </div>
              <div className="settings-block">
                <h3>Pin by coordinates</h3>
                <p className="dim">Optional: paste a latitude and longitude, for example from Google Maps.</p>
                <div className="form-row">
                  <div className="field grow">
                    <label htmlFor="shop-latitude">Latitude</label>
                    <input id="shop-latitude" type="number" min={-90} max={90} step="any" placeholder="28.613939" value={profile.latitude ?? ''} onChange={(event) => setProfile({ ...profile, latitude: event.target.value === '' ? null : Number(event.target.value) })} />
                  </div>
                  <div className="field grow">
                    <label htmlFor="shop-longitude">Longitude</label>
                    <input id="shop-longitude" type="number" min={-180} max={180} step="any" placeholder="77.209021" value={profile.longitude ?? ''} onChange={(event) => setProfile({ ...profile, longitude: event.target.value === '' ? null : Number(event.target.value) })} />
                  </div>
                </div>
              </div>
            </details>
          </>
        )}

        {error && <div className="error-box" role="alert">{error}</div>}
        {conflict && (
          <div className="notice warn">
            <div>
              <strong>These settings changed on another screen</strong>
              <p>Reload to see the latest. Your unsaved edits on this page will be replaced.</p>
            </div>
            <button type="button" className="secondary" onClick={() => setReloadTick((n) => n + 1)}>Reload latest</button>
          </div>
        )}

        <div className="settings-savebar">
          <button type={pricesPage ? 'submit' : 'button'} onClick={pricesPage ? undefined : () => void save()} disabled={saving || priceErrorsPresent || !profile?.name.trim() || !profile.address.trim()}>
            {saving ? 'Saving…' : pricesPage ? 'Save prices' : 'Save changes'}
          </button>
          <span className="settings-saved" role="status">{saved ? 'Saved' : ''}</span>
        </div>
      </SettingsBody>
      {!pricesPage && profile && getShopRole() === 'owner' && <StaffSection />}
    </div>
  );
}

interface StaffRow {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'staff';
  createdAt: string;
}

function StaffSection() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [form, setForm] = useState({ email: '', name: '', pin: '' });
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const res = await api<{ staff: StaffRow[] }>('/api/shop/staff', { role: 'shop' });
      setStaff(res.staff);
    } catch {
      /* ignore — owner-only route, silently hidden if it 401s */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addStaff() {
    setError('');
    try {
      await api('/api/shop/staff', { method: 'POST', role: 'shop', body: form });
      setForm({ email: '', name: '', pin: '' });
      setShowForm(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add this staff member.');
    }
  }

  async function removeStaff(id: string) {
    if (!confirm('Remove this staff member? They can no longer sign in.')) return;
    try {
      await api(`/api/shop/staff/${id}`, { method: 'DELETE', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove this staff member.');
    }
  }

  return (
    <section className="settings-block" aria-labelledby="staff-title">
      <div className="settings-block-head">
        <h2 id="staff-title">Staff</h2>
        <button type="button" className="secondary small" onClick={() => setShowForm((v) => !v)} aria-expanded={showForm}>
          {showForm ? 'Close' : 'Add staff'}
        </button>
      </div>
      <p className="dim">Counter staff sign in with a short PIN, so the shared counter PC is quick to use. They cannot change prices or settings.</p>

      {showForm && (
        <div className="staff-form" role="group" aria-label="Add a staff member">
          <div className="field"><label htmlFor="staff-name">Name</label><input id="staff-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="staff-email">Email</label><input id="staff-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="staff-pin">PIN (4 to 6 digits)</label><input id="staff-pin" type="text" inputMode="numeric" maxLength={6} value={form.pin} onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })} /></div>
          <div><button type="button" disabled={!form.name || !form.email || form.pin.length < 4} onClick={() => void addStaff()}>Add staff member</button></div>
        </div>
      )}

      <ul className="staff-list">
        {staff.map((s) => (
          <li key={s.id}>
            <div>
              <strong>{s.name}</strong>
              <span className="dim">{s.email}{s.role === 'owner' ? ' · owner' : ''}</span>
            </div>
            {s.role === 'staff' && (
              <button type="button" className="quiet danger-text" onClick={() => void removeStaff(s.id)}>Remove</button>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="field-error" role="alert">{error}</p>}
    </section>
  );
}
