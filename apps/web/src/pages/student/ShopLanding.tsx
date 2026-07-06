import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, rememberShop, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';

interface PublicShop {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
  open: boolean;
  rateCard: { pagePrices: Record<string, number> };
  capabilities: { color: boolean; paperSizes: string[] };
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
      .then((r) => {
        setShop(r.shop);
        if (getToken('student')) rememberShop(slug);
      })
      .catch(() => setError('This shop link is not valid.'));
  }, [slug]);

  // conversion completion arrives on the student socket; poll as fallback
  useEffect(() => {
    if (!loggedIn || !converting) return;
    const socket = getStudentSocket();
    const onReady = (p: { fileId: string }) => {
      if (p.fileId === converting) navigate(`/s/${slug}/file/${p.fileId}`);
    };
    const onFailed = (p: { fileId: string; error: string }) => {
      if (p.fileId === converting) {
        setConverting(null);
        setError(`That file didn't work: ${p.error}`);
      }
    };
    socket?.on('file:ready', onReady);
    socket?.on('file:failed', onFailed);
    const poll = setInterval(async () => {
      try {
        const { file } = await api<{ file: { status: string; error?: string } }>(
          `/api/files/${converting}`,
          { role: 'student' },
        );
        if (file.status === 'ready') navigate(`/s/${slug}/file/${converting}`);
        if (file.status === 'failed') {
          setConverting(null);
          setError(`That file didn't work: ${file.error ?? ''}`);
        }
      } catch {
        /* keep polling */
      }
    }, 2500);
    return () => {
      socket?.off('file:ready', onReady);
      socket?.off('file:failed', onFailed);
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
      setError(err instanceof Error ? err.message : 'Upload failed — try again.');
    } finally {
      setUploading(false);
    }
  }

  if (error && !shop) {
    return (
      <div className="page">
        <Topbar />
        <p className="error">{error}</p>
      </div>
    );
  }
  if (!shop) {
    return (
      <div className="page">
        <Topbar />
        <p className="dim">Loading…</p>
      </div>
    );
  }

  const a4bw = shop.rateCard.pagePrices['A4_bw'];

  return (
    <div className="page">
      <Topbar right={loggedIn ? <Link to="/home">Home</Link> : undefined} />
      <h1>{shop.name}</h1>
      <p className="dim">
        {shop.address}
        {shop.campusName ? ` · ${shop.campusName}` : ''}
      </p>
      <div className="row">
        <span className={`stamp ${shop.open ? 'green' : 'red'}`}>
          {shop.open ? 'taking jobs' : 'closed'}
        </span>
        {a4bw !== undefined && (
          <span className="dim mono">A4 B/W {rupees(a4bw)}/page</span>
        )}
        {shop.capabilities.color && <span className="stamp blue">colour</span>}
      </div>

      {!loggedIn ? (
        <PhoneLogin onDone={() => setLoggedIn(true)} />
      ) : converting ? (
        <div className="ticket">
          <div className="eyebrow">preparing preview</div>
          <div className="ticket-num" aria-hidden>
            …
          </div>
          <div className="sub">Converting your file to a print-ready PDF. What you'll see is exactly what prints.</div>
        </div>
      ) : (
        <div className="card stack">
          <div>
            <h2 style={{ margin: '0 0 2px' }}>Send a file to print</h2>
            <p className="dim" style={{ margin: 0 }}>
              PDF, Word (.docx), JPG or PNG · up to 25 MB
            </p>
          </div>
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
          {!shop.open && <p className="dim">The shop has no printer online right now.</p>}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
