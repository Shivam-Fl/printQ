import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, clearToken, getToken } from '../../api.js';
import { enablePush, pushPermission } from '../../push.js';
import { resetSockets } from '../../socket.js';
import StudentShell from '../../components/StudentShell.js';
import Topbar from '../../components/Topbar.js';
import { IconBell, IconLogout } from '../../components/Icons.js';

interface Me {
  name: string | null;
  phone: string;
}

export default function Profile() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const [pushState, setPushState] = useState(pushPermission());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!getToken('student')) {
      navigate('/login', { replace: true });
      return;
    }
    api<{ student: Me }>('/api/auth/student/me', { role: 'student' })
      .then((r) => {
        setMe(r.student);
        setName(r.student.name ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load your profile'));
  }, [navigate]);

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/student/me', { method: 'PATCH', role: 'student', body: { name } });
      setMe((m) => (m ? { ...m, name } : m));
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your name');
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (import.meta.env.VITE_STUDENT_AUTH_PROVIDER === 'firebase') {
      const { signOutFirebasePhoneAuth } = await import('../../firebasePhoneAuth.js');
      await signOutFirebasePhoneAuth().catch(() => undefined);
    }
    clearToken('student');
    resetSockets();
    navigate('/', { replace: true });
  }

  const initial = (me?.name?.trim()?.[0] ?? '?').toUpperCase();

  return (
    <StudentShell>
      <div className="page">
        <Topbar tag="profile" />
        <div className="row" style={{ gap: 14, margin: '8px 0 4px' }}>
          <div className="avatar">{initial}</div>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.4rem' }}>{me?.name ?? '—'}</h1>
            <div className="dim mono">{me?.phone ?? ''}</div>
          </div>
        </div>

        <div className="card">
          {editing ? (
            <div className="stack">
              <div>
                <label htmlFor="pname">Your name</label>
                <input id="pname" type="text" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
              </div>
              <div className="row">
                <button onClick={save} disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
                <button className="ghost" onClick={() => { setEditing(false); setName(me?.name ?? ''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="row between">
              <div>
                <strong>Name</strong>
                <p className="dim" style={{ margin: '2px 0 0' }}>{me?.name ?? 'Not set'}</p>
              </div>
              <button className="ghost small" onClick={() => setEditing(true)}>Edit</button>
            </div>
          )}
          {saved && <span className="stamp green" style={{ marginTop: 10 }}>saved ✓</span>}
          {error && <div className="error-box" role="alert">{error}</div>}
        </div>

        <div className="card" style={{ padding: 0 }}>
          <button
            className="list-row"
            style={{ width: '100%', background: 'none' }}
            onClick={async () => {
              const ok = await enablePush();
              setPushState(ok ? 'granted' : pushPermission());
            }}
          >
            <span className="lead">
              <span className="ic"><IconBell /></span>
              <span>
                <div>Notifications</div>
                <div className="dim">
                  {pushState === 'granted'
                    ? 'On — we\'ll alert you as your checked-in position approaches'
                    : pushState === 'denied'
                      ? 'Blocked in browser settings'
                      : 'Get pinged even when the app is closed'}
                </div>
              </span>
            </span>
            <span className={`stamp ${pushState === 'granted' ? 'green' : ''}`}>
              {pushState === 'granted' ? 'on' : 'turn on'}
            </span>
          </button>

          <button className="list-row" style={{ width: '100%', background: 'none', color: 'var(--danger)' }} onClick={() => void logout()}>
            <span className="lead">
              <span className="ic" style={{ color: 'var(--danger)' }}><IconLogout /></span>
              <span>Log out</span>
            </span>
          </button>
        </div>

        <p className="dim" style={{ textAlign: 'center', marginTop: 12 }}>PrintQ · add to home screen for the full app</p>
      </div>
    </StudentShell>
  );
}
