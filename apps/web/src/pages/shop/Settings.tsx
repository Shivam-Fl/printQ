import { useCallback, useEffect, useState } from 'react';
import { api, getShopRole, getToken } from '../../api.js';
import { useNavigate } from 'react-router-dom';
import ShopNav from '../../components/ShopNav.js';
import ShopLocationPicker from '../../components/ShopLocationPicker.js';

interface Paper {
  id: string;
  label: string;
  bwPaise: number;
  colorPaise: number | null;
}
interface Binding {
  id: string;
  label: string;
  paise: number;
}
interface Options {
  papers: Paper[];
  bindings: Binding[];
  duplexEnabled: boolean;
}
interface ShopProfile {
  name: string;
  address: string;
  campusName: string | null;
  slug: string;
  latitude: number | null;
  longitude: number | null;
  checkInRadiusM: number;
  locationUpdatedAt: string | null;
}
interface LocationSearchResult {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || `opt-${Date.now()}`;
const rupees = (paise: number | null) => (paise == null ? '' : (paise / 100).toFixed(2));
const toPaise = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.round(Number(v) * 100)));

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

  useEffect(() => {
    if (!getToken('shop')) {
      navigate('/dashboard/login');
      return;
    }
    api<{ shop: ShopProfile & { printOptions: Options; autoAssignEnabled: boolean } }>('/api/shop/me', { role: 'shop' })
      .then((r) => {
        setOpts(r.shop.printOptions);
        setProfile({
          name: r.shop.name,
          address: r.shop.address,
          campusName: r.shop.campusName,
          slug: r.shop.slug,
          latitude: r.shop.latitude,
          longitude: r.shop.longitude,
          checkInRadiusM: r.shop.checkInRadiusM,
          locationUpdatedAt: r.shop.locationUpdatedAt,
        });
        setLocationQuery([r.shop.address, r.shop.campusName].filter(Boolean).join(', '));
        setAutoAssign(r.shop.autoAssignEnabled);
      })
      .catch(() => navigate('/dashboard/login'));
  }, [navigate]);

  if (!opts) {
    return (
      <div className="page wide">
        <ShopNav />
        <p className="dim">Loading…</p>
      </div>
    );
  }

  const setPaper = (i: number, patch: Partial<Paper>) =>
    setOpts({ ...opts, papers: opts.papers.map((p, idx) => (idx === i ? { ...p, ...patch } : p)) });
  const setBinding = (i: number, patch: Partial<Binding>) =>
    setOpts({ ...opts, bindings: opts.bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });

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
    // clean up: drop empty-label rows, ensure ids
    const papers = opts.papers
      .filter((p) => p.label.trim())
      .map((p) => ({ ...p, id: p.id || slug(p.label), bwPaise: p.bwPaise || 0 }));
    const bindings = opts.bindings.filter((b) => b.label.trim()).map((b) => ({ ...b, id: b.id || slug(b.label) }));
    if (papers.length === 0) {
      setError('Add at least one paper type.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api('/api/shop/me', {
        method: 'PATCH',
        role: 'shop',
        body: {
          name: profile.name,
          address: profile.address,
          campusName: profile.campusName?.trim() || null,
          latitude: profile.latitude,
          longitude: profile.longitude,
          checkInRadiusM: profile.checkInRadiusM,
          printOptions: { papers, bindings, duplexEnabled: opts.duplexEnabled },
          autoAssignEnabled: autoAssign,
        },
      });
      setOpts({ papers, bindings, duplexEnabled: opts.duplexEnabled });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Only the owner can change settings');
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
              <div className="field grow"><label htmlFor="profile-campus">Campus</label><input id="profile-campus" placeholder="Optional" value={profile.campusName ?? ''} onChange={(event) => setProfile({ ...profile, campusName: event.target.value })} /></div>
            </div>
            <div className="field"><label htmlFor="profile-address">Counter address</label><input id="profile-address" value={profile.address} onChange={(event) => setProfile({ ...profile, address: event.target.value })} /></div>
          </div>
        </section>
      )}

      {profile && (
        <section className="settings-section">
          <div className="settings-section-copy">
            <h2>Secure arrival check-in</h2>
            <p>Set the exact shop entrance once. Students must be inside this radius before joining the live line.</p>
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
                  {![20, 50, 100].includes(profile.checkInRadiusM) && (
                    <option value={profile.checkInRadiusM}>{profile.checkInRadiusM} m · current setting</option>
                  )}
                  <option value={20}>20 m · strict, best near an entrance</option>
                  <option value={50}>50 m · recommended</option>
                  <option value={100}>100 m · indoor GPS fallback</option>
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

      <div className="settings-surface">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Paper types &amp; price</h2>
          <button className="small" onClick={() => setOpts({ ...opts, papers: [...opts.papers, { id: '', label: '', bwPaise: 200, colorPaise: null }] })}>+ Add paper</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>Leave the colour price blank if that paper is black &amp; white only.</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr auto', gap: 10, fontSize: '0.72rem', color: 'var(--pencil)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 8 }}>
          <span>Name</span><span>₹ B/W / page</span><span>₹ Colour / page</span><span></span>
        </div>
        {opts.papers.map((p, i) => (
          <div key={i} className="opt-row">
            <input type="text" placeholder="e.g. College sheet" value={p.label} onChange={(e) => setPaper(i, { label: e.target.value })} />
            <input type="number" min={0} step={0.5} value={rupees(p.bwPaise)} onChange={(e) => setPaper(i, { bwPaise: toPaise(e.target.value) ?? 0 })} />
            <input type="number" min={0} step={0.5} placeholder="—" value={rupees(p.colorPaise)} onChange={(e) => setPaper(i, { colorPaise: toPaise(e.target.value) })} />
            <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, papers: opts.papers.filter((_, idx) => idx !== i) })}>×</button>
          </div>
        ))}
      </div>

      <div className="settings-surface">
        <div className="row between">
          <h2 style={{ margin: 0 }}>Binding &amp; finishing</h2>
          <button className="small" onClick={() => setOpts({ ...opts, bindings: [...opts.bindings, { id: '', label: '', paise: 0 }] })}>+ Add binding</button>
        </div>
        <p className="dim" style={{ marginTop: 4 }}>"None" is always offered. Add extras like stapling or spiral.</p>
        {opts.bindings.map((b, i) => (
          <div key={i} className="opt-row" style={{ gridTemplateColumns: '1.4fr 1fr auto' }}>
            <input type="text" placeholder="e.g. Spiral binding" value={b.label} onChange={(e) => setBinding(i, { label: e.target.value })} />
            <input type="number" min={0} step={1} value={rupees(b.paise)} onChange={(e) => setBinding(i, { paise: toPaise(e.target.value) ?? 0 })} />
            <button className="rm" title="Remove" onClick={() => setOpts({ ...opts, bindings: opts.bindings.filter((_, idx) => idx !== i) })}>×</button>
          </div>
        ))}
      </div>

      <div className="settings-surface row between">
        <div>
          <strong>Offer double-sided printing</strong>
          <p className="dim" style={{ margin: '4px 0 0' }}>Let students choose one-sided or both sides.</p>
        </div>
        <button className={opts.duplexEnabled ? '' : 'ghost'} onClick={() => setOpts({ ...opts, duplexEnabled: !opts.duplexEnabled })}>{opts.duplexEnabled ? 'ON' : 'OFF'}</button>
      </div>

      <div className="row" style={{ marginTop: 8 }}>
        <button disabled={saving || !profile?.name.trim() || !profile.address.trim()} onClick={save}>{saving ? 'Saving…' : 'Save all changes'}</button>
        {saved && <span className="stamp green">saved ✓</span>}
      </div>
      {error && <p className="error">{error}</p>}
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
