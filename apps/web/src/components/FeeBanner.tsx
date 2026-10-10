import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api, getShopRole } from '../api.js';
import { bannerCopy, type FeeStatus } from '../lib/fees.js';
import { getShopSocket } from '../socket.js';

/** Presentational so it can be tested without the network. */
export function FeeBannerView({ status, isOwner, onEarningsPage }: { status: FeeStatus | null; isOwner: boolean; onEarningsPage?: boolean }) {
  if (!status) return null;
  const copy = bannerCopy(status, isOwner);
  if (!copy) return null;
  return (
    <div className={`fee-banner ${copy.tone}`} role="status">
      <span>{copy.text}</span>
      {isOwner && !onEarningsPage && <Link to="/dashboard/earnings">Pay now</Link>}
    </div>
  );
}

/** Persistent on every shop page until the fee is resolved; refreshes on server nudges. */
export default function FeeBanner() {
  const [status, setStatus] = useState<FeeStatus | null>(null);
  const { pathname } = useLocation();
  const isOwner = getShopRole() === 'owner';

  useEffect(() => {
    let alive = true;
    const load = () => {
      api<{ status: FeeStatus }>('/api/shop/fees/status', { role: 'shop' })
        .then((r) => { if (alive) setStatus(r.status); })
        .catch(() => undefined);
    };
    load();
    const socket = getShopSocket();
    socket?.on('fee:update', load);
    const timer = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      socket?.off('fee:update', load);
      clearInterval(timer);
    };
  }, []);

  return <FeeBannerView status={status} isOwner={isOwner} onEarningsPage={pathname.startsWith('/dashboard/earnings')} />;
}
