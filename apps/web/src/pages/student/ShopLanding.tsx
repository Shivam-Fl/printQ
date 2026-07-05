import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import PhoneLogin from './PhoneLogin.js';

interface PublicShop {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
  open: boolean;
  rateCard: { pagePrices: Record<string, number> };
}

export default function ShopLanding() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const [shop, setShop] = useState<PublicShop | null>(null);
  const [loggedIn, setLoggedIn] = useState(Boolean(getToken('student')));
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ shop: PublicShop }>(`/api/public/shops/${slug}`)
      .then((r) => setShop(r.shop))
      .catch(() => setError('Shop not found'));
  }, [slug]);

  // conversion completion arrives on the student socket
  useEffect(() => {
    if (!loggedIn || !converting) return;
    const socket = getStudentSocket();
    if (!socket) return;
    const onReady = (p: { fileId: string }) => {
      if (p.fileId === converting) navigate(`/s/${slug}/file/${p.fileId}`);
    };
    const onFailed = (p: { fileId: string; error: string }) => {
      if (p.fileId === converting) {
        setConverting(null);
        setError(`Could not process that file: ${p.error}`);
      }
    };
    socket.on('file:ready', onReady);
    socket.on('file:failed', onFailed);
    // fallback poll in case the socket missed the event
    const poll = setInterval(async () => {
      try {
        const { file } = await api<{ file: { status: string; error?: string } }>(
          `/api/files/${converting}`,
          { role: 'student' },
        );
        if (file.status === 'ready') navigate(`/s/${slug}/file/${converting}`);
        if (file.status === 'failed') {
          setConverting(null);
          setError(`Could not process that file: ${file.error ?? ''}`);
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => {
      socket.off('file:ready', onReady);
      socket.off('file:failed', onFailed);
      clearInterval(poll);
    };
  }, [loggedIn, converting, navigate, slug]);

  async function onFileChosen(file: File) {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('shopSlug', slug);
      formData.append('file', file);
      const res = await api<{ file: { id: string } }>('/api/files', {
        method: 'POST',
        role: 'student',
        formData,
      });
      setConverting(res.file.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }

  if (error && !shop) return <div className="page"><p className="error">{error}</p></div>;
  if (!shop) return <div className="page"><p className="dim">Loading…</p></div>;

  const a4bw = shop.rateCard.pagePrices['A4_bw'];

  return (
    <div className="page">
      <div className="topbar">
        <span className="brand">PrintQ</span>
        {loggedIn && <Link to="/jobs">My jobs</Link>}
      </div>
      <h1>{shop.name}</h1>
      <p className="dim">
        {shop.address}
        {shop.campusName ? ` · ${shop.campusName}` : ''}
      </p>
      <span className={`badge ${shop.open ? 'ok' : 'danger'}`}>
        {shop.open ? 'Accepting jobs' : 'Currently closed'}
      </span>
      {a4bw !== undefined && <p className="dim">A4 B/W from {rupees(a4bw)} per page</p>}

      {!loggedIn ? (
        <PhoneLogin onDone={() => setLoggedIn(true)} />
      ) : converting ? (
        <div className="card stack">
          <p>Preparing your print-ready preview…</p>
          <p className="dim">PDF, Word and photos are converted so what you see is exactly what prints.</p>
        </div>
      ) : (
        <div className="card stack">
          <h2 style={{ margin: 0 }}>Send a file to print</h2>
          <p className="dim">PDF, Word (.docx), JPG or PNG · max 25 MB</p>
          <input
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFileChosen(f);
            }}
          />
          <button disabled={uploading || !shop.open} onClick={() => fileInput.current?.click()}>
            {uploading ? 'Uploading…' : 'Choose file'}
          </button>
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
