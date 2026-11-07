import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, signOutShop } from '../api.js';
import { resetSockets } from '../socket.js';

/**
 * Shown on /dashboard/login and /dashboard/register when this device already
 * holds a shop session, so a second sign-in or sign-up never silently replaces
 * it. A 401 (expired session) hands the form back via onSignedOut.
 */
export default function ShopSignedIn({ to, hint, onSignedOut }: { to: string; hint?: string; onSignedOut: () => void }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<{ shop: { name: string } }>('/api/shop/me', { role: 'shop' })
      .then((r) => { if (!cancelled) setName(r.shop.name); })
      .catch((err) => {
        // 401: the token was stale and has been cleared. Anything else: keep the notice without a name.
        if (!cancelled && err instanceof ApiError && err.status === 401) onSignedOut();
      });
    return () => { cancelled = true; };
  }, [onSignedOut]);

  async function signOut() {
    setBusy(true);
    await signOutShop();
    resetSockets();
    setBusy(false);
    onSignedOut();
  }

  return (
    <div className="auth-card stack shop-signed-in">
      <p className="shop-signed-in-title">
        You’re signed in as <strong>{name || 'your shop'}</strong>.
      </p>
      {hint && <p className="form-footnote">{hint}</p>}
      <Link className="button-link full-button" to={to}>Go to dashboard</Link>
      <button type="button" className="ghost full-button" onClick={() => void signOut()} disabled={busy}>
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
    </div>
  );
}
