import { useCallback, useEffect, useState } from 'react';
import { MAX_BINDING_PRICE_PAISE, MAX_PAGE_PRICE_PAISE } from '@printq/shared';
import { api, ApiError, getShopRole, getToken } from '../../api.js';
import { useNavigate } from 'react-router-dom';
import QueueSettings from '../../components/QueueSettings.js';
import ShopNav from '../../components/ShopNav.js';
import ShopLocationPicker from '../../components/ShopLocationPicker.js';
import {
  buildSettingsPatch,
  coordinateWarning,
  formatRupeesField,
  parseRupees,
  priceText,
  typePrice,
  type OptionsDraft,
  type SettingsDraft,
} from './settingsForm.js';

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
interface Campus {
  id: string;
  slug: string;
  name: string;
  address: string;
}
interface LocationSearchResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
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

export default function Settings() {
  const navigate = useNavigate();
  const [opts, setOpts] = useState<Options | null>(null);
  const [profile, setProfile] = useState<ShopProfile | null>(null);
  const [autoAssign, setAutoAssign] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [locationBusy, setLocationBusy] = useState(false);
  const [locationMessage, setLocationMessage] = useState('');
  const [locationPickerOpen, setLocationPickerOpen] = useState(false);
  const [locationCenter, setLocationCenter] = useState<{ latitude: number; longitude: number; zoom?: number } | null>(null);
  const [locationQuery, setLocationQuery] = useState('');
  const [locationSearchBusy, setLocationSearchBusy] = useState(false);
  const [locationResults, setLocationResults] = useState<LocationSearchResult[]>([]);
  const [campuses, setCampuses] = useState<Campus[]>([]);
  // What the server last told us — saves send only the difference from this.
  const [baseline, setBaseline] = useState<{ draft: SettingsDraft; menuVersion: number } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    Promise.all([
      api<{ shop: ShopProfile & { printOptions: StoredOptions; printOptionsVersion: number; autoAssignEnabled: boolean } }>('/api/shop/me', { role: 'shop' }),
      api<{ campuses: Campus[] }>('/api/public/campuses'),
    ])
      .then(([r, campusResult]) => {
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
        setLocationQuery([r.shop.address, r.shop.campus?.name ?? r.shop.campusName].filter(Boolean).join(', '));
        setAutoAssign(r.shop.autoAssignEnabled);
      })
      .catch(() => navigate('/dashboard/login'));
  }, [navigate, reloadTick]);

  if (!opts) {
    return (
      <div className="page wide">
        <ShopNav />
        <p className="dim">Loading…</p>
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

  function captureShopLocation() {
    if (!navigator.geolocation) {
      setLocationPickerOpen(true);
      setLocationMessage('This device cannot provide location. Place the entrance pin on the map instead.');
      return;
    }
    setLocationBusy(true);
    setLocationMessage('');
    setError('');
    const applyPosition = (position: GeolocationPosition, approximate: boolean) => {
      const latitude = Number(position.coords.latitude.toFixed(6));
      const longitude = Number(position.coords.longitude.toFixed(6));
      const accuracy = position.coords.accuracy;
      const zoom = accuracy <= 250 ? 17 : accuracy <= 2_000 ? 14 : accuracy <= 10_000 ? 12 : 10;
      setLocationCenter({ latitude, longitude, zoom });
      if (accuracy > 100 || approximate) {
        setLocationPickerOpen(true);
        setLocationMessage(`The PC found your area with about ${Math.round(accuracy)} m accuracy. Click the exact shop entrance on the map.`);
      } else {
        setProfile((current) => current ? {
          ...current,
          latitude,
          longitude,
          locationUpdatedAt: new Date(position.timestamp).toISOString(),
        } : current);
        setLocationMessage(`Location captured with about ${Math.round(accuracy)} m accuracy. Save changes to activate it.`);
      }
      setLocationBusy(false);
    };
    const openSearchFallback = (permissionDenied: boolean) => {
      setLocationPickerOpen(true);
      setLocationMessage(permissionDenied
        ? 'Location access is off. Search your college or address below, then click the exact entrance.'
        : 'The PC could not provide a location. Search your college or address below, then click the exact entrance.');
      setLocationBusy(false);
    };
    navigator.geolocation.getCurrentPosition(
      (position) => applyPosition(position, false),
      (reason) => {
        if (reason.code === reason.PERMISSION_DENIED) {
          openSearchFallback(true);
          return;
        }
        setLocationMessage('Precise location was unavailable. Trying the PC’s approximate network location…');
        navigator.geolocation.getCurrentPosition(
          (position) => applyPosition(position, true),
          () => openSearchFallback(false),
          { enableHighAccuracy: false, timeout: 10_000, maximumAge: 300_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  }

  async function searchLocation() {
    const query = locationQuery.trim();
    if (query.length < 3) {
      setLocationMessage('Enter a college, shop address, area or city to search.');
      return;
    }
    setLocationSearchBusy(true);
    setLocationResults([]);
    setError('');
    try {
      const response = await api<{ results: LocationSearchResult[] }>(
        `/api/shop/location-search?q=${encodeURIComponent(query)}`,
        { role: 'shop' },
      );
      setLocationResults(response.results);
      setLocationMessage(response.results.length
        ? 'Select the closest result, then click the exact shop entrance on the map.'
        : 'No matching place found. Add the city or PIN code and search again.');
    } catch (err) {
      setLocationMessage(err instanceof Error ? err.message : 'Could not search this address.');
    } finally {
      setLocationSearchBusy(false);
    }
  }

  function chooseLocationResult(result: LocationSearchResult) {
    setLocationCenter({ latitude: result.latitude, longitude: result.longitude, zoom: 17 });
    setLocationResults([]);
    setLocationMessage(`Showing ${result.label}. Now click the exact shop entrance.`);
  }

  function selectShopLocation(latitude: number, longitude: number) {
    setProfile((current) => current ? {
      ...current,
      latitude,
      longitude,
      locationUpdatedAt: new Date().toISOString(),
    } : current);
    setLocationMessage('Entrance pin selected. Save all changes to activate it.');
    setError('');
  }

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
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && (err.body as { code?: string } | undefined)?.code === 'SETTINGS_CHANGED_ELSEWHERE') {
        setConflict(true);
      }
      setError(err instanceof Error ? err.message : 'Only the owner can change settings');
    } finally {
      setSaving(false);
    }
  }

  async function verifyMerchantUpi() {
    if (!profile?.counterUpiVpa || !profile.counterUpiPayeeName) {
      setError('Save both the merchant UPI VPA and payee name first.');
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
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record merchant UPI verification');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page wide">
      <ShopNav />
      <div className="page-heading">
        <div><span className="eyebrow-label">Storefront &amp; operations</span><h1>Settings</h1><p>Keep the shop details, print menu and team access accurate for students and staff.</p></div>
      </div>

      {profile && (
        <section className="settings-section">
          <div className="settings-section-copy"><h2>Shop profile</h2><p>These details appear on your public order page and QR link.</p><a href={`/s/${profile.slug}`} target="_blank" rel="noreferrer">Preview student page ↗</a></div>
          <div className="settings-surface stack">
            <div className="form-row">
              <div className="field grow"><label htmlFor="profile-name">Shop name</label><input id="profile-name" value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></div>
              <div className="field grow">
                <label htmlFor="profile-campus">Approved campus</label>
                <select
                  id="profile-campus"
                  value={profile.campusId ?? ''}
                  onChange={(event) => {
                    const campus = campuses.find((item) => item.id === event.target.value) ?? null;
                    setProfile({ ...profile, campusId: campus?.id ?? null, campus, campusName: campus?.name ?? null });
                  }}
                >
                  <option value="">Choose a campus before requesting verification</option>
                  {campuses.map((campus) => <option key={campus.id} value={campus.id}>{campus.name}</option>)}
                </select>
                <span className="field-help">Only a platform-approved campus can be published to students.</span>
              </div>
            </div>
            <div className="field"><label htmlFor="profile-address">Counter address</label><input id="profile-address" value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} /></div>
          </div>
        </section>
      )}

      {profile && (
        <section className="settings-section">
          <div className="settings-section-copy">
            <h2>Counter queue</h2>
            <p>Decide how many students are called to the counter at once and how long they get to arrive.</p>
          </div>
          <QueueSettings
            capacity={profile.counterCapacity}
            graceSeconds={profile.revealGraceSeconds}
            onChange={(next) => setProfile({ ...profile, ...next })}
          />
        </section>
      )}

      {profile && (
        <section className="settings-section">
          <div className="settings-section-copy">
            <h2>Secure arrival check-in</h2>
            <p>Set the exact shop entrance once. Students must be inside this radius before joining the live line. 200 m lets someone in the next building or across the road check in.</p>
          </div>
          <div className="settings-surface stack">
            <div className="row between">
              <div>
                <strong>{profile.latitude != null && profile.longitude != null ? 'Counter location captured' : 'Location required before opening'}</strong>
                <p className="dim" style={{ margin: '4px 0 0' }}>PrintQs checks location once at arrival and does not store the student's coordinates.</p>
              </div>
              <span className={`stamp ${profile.latitude != null && profile.longitude != null ? 'green' : 'yellow'}`}>
                {profile.latitude != null && profile.longitude != null ? 'active' : 'required'}
              </span>
            </div>
            <div className="form-row">
              <div className="field grow">
                <label htmlFor="check-in-radius">Allowed distance</label>
                <select
                  id="check-in-radius"
                  value={profile.checkInRadiusM}
                  onChange={(event) => setProfile({ ...profile, checkInRadiusM: Number(event.target.value) })}
                >
                  {![20, 50, 100, 200].includes(profile.checkInRadiusM) && (
                    <option value={profile.checkInRadiusM}>{profile.checkInRadiusM} m · current setting</option>
                  )}
                  <option value={20}>20 m · strict, best near an entrance</option>
                  <option value={50}>50 m · only at the shop</option>
                  <option value={100}>100 m · indoor GPS fallback</option>
                  <option value={200}>200 m · recommended, next building or across the road</option>
                </select>
                <span className="field-help">Smaller zones reduce remote check-ins but need a more accurate phone location.</span>
              </div>
              <div className="field grow">
                <label>Counter coordinates</label>
                <div className="location-actions">
                  <button className="secondary" disabled={locationBusy} onClick={captureShopLocation}>
                    {locationBusy ? 'Checking location…' : 'Use this device'}
                  </button>
                  <button className="ghost" onClick={() => setLocationPickerOpen((open) => !open)}>
                    {locationPickerOpen ? 'Close map' : 'Choose on map'}
                  </button>
                </div>
              </div>
            </div>
            {locationMessage && <p className="dim" style={{ margin: 0 }} role="status">{locationMessage}</p>}
            {locationPickerOpen && (
              <>
                <form className="location-search" onSubmit={(event) => { event.preventDefault(); void searchLocation(); }}>
                  <div className="field grow">
                    <label htmlFor="location-search">Find your shop area</label>
                    <input
                      id="location-search"
                      type="text"
                      value={locationQuery}
                      onChange={(event) => setLocationQuery(event.target.value)}
                      placeholder="College, shop address, area or PIN code"
                      autoComplete="street-address"
                    />
                  </div>
                  <button type="submit" disabled={locationSearchBusy || locationQuery.trim().length < 3}>
                    {locationSearchBusy ? 'Searching…' : 'Find address'}
                  </button>
                </form>
                {locationResults.length > 0 && (
                  <div className="location-search-results" role="list" aria-label="Address matches">
                    {locationResults.map((result) => (
                      <button type="button" key={result.id} onClick={() => chooseLocationResult(result)} role="listitem">
                        <span className="location-result-pin">PIN</span>
                        <span>{result.label}</span>
                      </button>
                    ))}
                  </div>
                )}
                <ShopLocationPicker
                  latitude={profile.latitude}
                  longitude={profile.longitude}
                  center={locationCenter}
                  onChange={selectShopLocation}
                />
                <span className="location-attribution">Address search and map data © OpenStreetMap contributors</span>
              </>
            )}
            {locationHint && <p className="warn-note" role="status">{locationHint}</p>}
            <details className="location-coordinates">
              <summary>Enter coordinates manually</summary>
              <p className="dim">Optional fallback: paste a latitude and longitude from Google Maps.</p>
              <div className="form-row">
                <div className="field grow">
                  <label htmlFor="shop-latitude">Latitude</label>
                  <input
                    id="shop-latitude"
                    type="number"
                    min={-90}
                    max={90}
                    step="any"
                    placeholder="e.g. 28.613939"
                    value={profile.latitude ?? ''}
                    onChange={(event) => setProfile({ ...profile, latitude: event.target.value === '' ? null : Number(event.target.value) })}
                  />
                </div>
                <div className="field grow">
                  <label htmlFor="shop-longitude">Longitude</label>
                  <input
                    id="shop-longitude"
                    type="number"
                    min={-180}
                    max={180}
                    step="any"
                    placeholder="e.g. 77.209021"
                    value={profile.longitude ?? ''}
                    onChange={(event) => setProfile({ ...profile, longitude: event.target.value === '' ? null : Number(event.target.value) })}
                  />
                </div>
              </div>
            </details>
          </div>
        </section>
      )}

      <div className="automation-panel">
        <div style={{ flex: 1, minWidth: 220 }}>
          <strong>Auto-assign printers</strong>
          <p className="dim" style={{ margin: '4px 0 0' }}>On: the counter code sends each job to the best printer automatically. Off: you pick from a dropdown.</p>
        </div>
        <button className={autoAssign ? '' : 'ghost'} onClick={() => setAutoAssign((v) => !v)}>{autoAssign ? 'ON' : 'OFF'}</button>
      </div>

      {profile && (
        <section className="settings-section">
          <div className="settings-section-copy">
            <h2>Counter merchant UPI</h2>
            <p>Students may pay the shop directly at the counter. A UPI screen, screenshot or typed reference never proves receipt—staff must check the merchant app first.</p>
          </div>
          <div className="settings-surface stack">
            <div className="form-row">
              <div className="field grow"><label htmlFor="merchant-upi-vpa">Merchant UPI VPA</label><input id="merchant-upi-vpa" placeholder="shop@bank" value={profile.counterUpiVpa ?? ''} onChange={(event) => setProfile({ ...profile, counterUpiVpa: event.target.value || null, counterUpiVerifiedAt: null })} /></div>
              <div className="field grow"><label htmlFor="merchant-upi-payee">Payee name in merchant app</label><input id="merchant-upi-payee" placeholder="Shop legal/display name" value={profile.counterUpiPayeeName ?? ''} onChange={(event) => setProfile({ ...profile, counterUpiPayeeName: event.target.value || null, counterUpiVerifiedAt: null })} /></div>
            </div>
            <div className="row between">
              <span className={`stamp ${profile.counterUpiVerifiedAt ? 'green' : 'yellow'}`}>{profile.counterUpiVerifiedAt ? `verified ${new Date(profile.counterUpiVerifiedAt).toLocaleDateString()}` : 'verification required'}</span>
              <button className="ghost small" disabled={saving || !profile.counterUpiVpa || !profile.counterUpiPayeeName} onClick={() => void verifyMerchantUpi()}>I checked the merchant app</button>
            </div>
          </div>
        </section>
      )}

      <div className="settings-surface">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Paper types &amp; price</h2>
          <button className="small" onClick={() => setOpts({ ...opts, papers: [...opts.papers, { id: '', label: '', bw: '2.00', color: '' }] })}>+ Add paper</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>Leave the colour price blank if that paper is black &amp; white only.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 10, fontSize: '0.72rem', color: 'var(--pencil)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
          <span>Name</span><span>₹ B/W / page</span><span>₹ Colour / page</span><span></span>
        </div>
        {opts.papers.map((p, i) => {
          const errors = paperErrors(p);
          return (
            <div key={i} className="opt-row">
              <input type="text" aria-label="Paper name" placeholder="e.g. College sheet" value={p.label} onChange={(e) => setPaper(i, { label: e.target.value })} />
              <input
                type="text"
                inputMode="decimal"
                aria-label={`B/W price per page for ${p.label || 'paper'}`}
                aria-invalid={Boolean(errors.bw)}
                value={p.bw}
                onChange={(e) => setPaper(i, { bw: typePrice(p.bw, e.target.value) })}
                onBlur={() => setPaper(i, { bw: formatRupeesField(p.bw) })}
              />
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Colour price per page for ${p.label || 'paper'}`}
                aria-invalid={Boolean(errors.color)}
                placeholder="—"
                value={p.color}
                onChange={(e) => setPaper(i, { color: typePrice(p.color, e.target.value) })}
                onBlur={() => setPaper(i, { color: formatRupeesField(p.color) })}
              />
              <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, papers: opts.papers.filter((_, idx) => idx !== i) })}>×</button>
              {(errors.bw || errors.color) && <p className="opt-error" role="alert">{errors.bw ?? errors.color}</p>}
            </div>
          );
        })}
      </div>

      <div className="settings-surface">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Binding &amp; finishing</h2>
          <button className="small" onClick={() => setOpts({ ...opts, bindings: [...opts.bindings, { id: '', label: '', price: '0.00' }] })}>+ Add binding</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>"None" is always offered. Add extras like stapling or spiral.</p>
        {opts.bindings.map((b, i) => {
          const errors = bindingErrors(b);
          return (
            <div key={i} className="opt-row" style={{ gridTemplateColumns: '1.4fr 1fr auto' }}>
              <input type="text" aria-label="Binding name" placeholder="e.g. Spiral binding" value={b.label} onChange={(e) => setBinding(i, { label: e.target.value })} />
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Price for ${b.label || 'binding'}`}
                aria-invalid={Boolean(errors.price)}
                value={b.price}
                onChange={(e) => setBinding(i, { price: typePrice(b.price, e.target.value) })}
                onBlur={() => setBinding(i, { price: formatRupeesField(b.price) })}
              />
              <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, bindings: opts.bindings.filter((_, idx) => idx !== i) })}>×</button>
              {errors.price && <p className="opt-error" role="alert">{errors.price}</p>}
            </div>
          );
        })}
      </div>

      <div className="settings-surface row between">
        <div>
          <strong>Offer double-sided printing</strong>
          <p className="dim" style={{ margin: '4px 0 0' }}>Let students choose one-sided or both sides.</p>
        </div>
        <button className={opts.duplexEnabled ? '' : 'ghost'} onClick={() => setOpts({ ...opts, duplexEnabled: !opts.duplexEnabled })}>{opts.duplexEnabled ? 'ON' : 'OFF'}</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={saving || priceErrorsPresent || !profile?.name.trim() || !profile.address.trim()} onClick={save}>{saving ? 'Saving…' : 'Save all changes'}</button>
        {saved && <span className="stamp green">saved ✓</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {conflict && (
        <div className="row" style={{ marginTop: 6 }}>
          <button className="secondary small" onClick={() => setReloadTick((n) => n + 1)}>Reload latest settings</button>
          <span className="dim">Your unsaved edits on this page will be replaced.</span>
        </div>
      )}
      <p className="dim" style={{ marginTop: 8 }}>Note: a paper/binding only appears to students if a printer that's marked online has it loaded (set that on the Printers page).</p>

      {getShopRole() === 'owner' && <StaffSection />}
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
      setError(err instanceof Error ? err.message : 'Could not add staff member');
    }
  }

  async function removeStaff(id: string) {
    if (!confirm('Remove this staff member?')) return;
    try {
      await api(`/api/shop/staff/${id}`, { method: 'DELETE', role: 'shop' });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove staff member');
    }
  }

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Staff</h2>
        <button className="small" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Close' : '+ Add staff'}
        </button>
      </div>
      <p className="dim" style={{ marginTop: 4 }}>
        Counter staff sign in with a short PIN instead of a password — quicker on a shared PC.
      </p>

      {showForm && (
        <div className="stack" style={{ marginTop: 8 }}>
          <input
            type="text"
            placeholder="Name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            type="email"
            placeholder="Email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
          <input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="4-6 digit PIN"
            value={form.pin}
            onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '') })}
          />
          <button
            disabled={!form.name || !form.email || form.pin.length < 4}
            onClick={addStaff}
          >
            Add staff member
          </button>
        </div>
      )}

      <div style={{ marginTop: 10 }}>
        {staff.map((s) => (
          <div key={s.id} className="row between" style={{ padding: '6px 0', borderTop: '1px solid var(--rule)' }}>
            <div>
              <strong>{s.name}</strong>{' '}
              <span className="dim">{s.email}</span>{' '}
              {s.role === 'owner' && <span className="stamp blue">owner</span>}
            </div>
            {s.role === 'staff' && (
              <button className="ghost small" onClick={() => removeStaff(s.id)}>Remove</button>
            )}
          </div>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
