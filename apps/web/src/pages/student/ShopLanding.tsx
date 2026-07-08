import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, rememberShop, rupees } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';

interface Paper {
  id: string;
  label: string;
  bwPaise: number;
  colorPaise: number | null;
}
interface PublicShop {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
  open: boolean;
  colorAvailable: boolean;
  rating: { average: number | null; count: number };
  options: { papers: Paper[]; bindings: { id: string; label: string; paise: number }[]; duplexEnabled: boolean };
}

/** Redirects to the specs page once `fileId` finishes converting (socket, with a polling fallback). */
function useFileConversionRedirect(
  slug: string,
  loggedIn: boolean,
  fileId: string | null,
  onDone: () => void,
  onError: (msg: string) => void,
) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!loggedIn || !fileId) return;
    const socket = getStudentSocket();
    const onReady = (p: { fileId: string }) => {
      if (p.fileId === fileId) navigate(`/s/${slug}/file/${p.fileId}`);
    };
    const onFailed = (p: { fileId: string; error: string }) => {
      if (p.fileId === fileId) {
        onDone();
        onError(`Couldn't process that: ${p.error}`);
      }
    };
    socket?.on('file:ready', onReady);
    socket?.on('file:failed', onFailed);
    const poll = setInterval(async () => {
      try {
        const { file } = await api<{ file: { status: string; error?: string } }>(`/api/files/${fileId}`, {
          role: 'student',
        });
        if (file.status === 'ready') navigate(`/s/${slug}/file/${fileId}`);
        if (file.status === 'failed') {
          onDone();
          onError(`Couldn't process that: ${file.error ?? ''}`);
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
  }, [loggedIn, fileId, navigate, slug, onDone, onError]);
}

/** Self-contained: manages its own "requested" state so the parent doesn't need to. */
function NotifyWhenOpen({ slug }: { slug: string }) {
  const [requested, setRequested] = useState(false);
  return (
    <div className="row between">
      <p className="dim" style={{ margin: 0 }}>The shop has no printer online right now.</p>
      <button
        className="ghost small"
        disabled={requested}
        onClick={async () => {
          await api(`/api/public/shops/${slug}/notify-when-open`, { method: 'POST', role: 'student' }).catch(
            () => undefined,
          );
          setRequested(true);
        }}
      >
        {requested ? 'We\'ll let you know ✓' : 'Notify me when open'}
      </button>
    </div>
  );
}

export default function ShopLanding() {
  const { slug = '' } = useParams();
  const [shop, setShop] = useState<PublicShop | null>(null);
  const [loggedIn, setLoggedIn] = useState(Boolean(getToken('student')));
  const [uploading, setUploading] = useState(false);
  const [converting, setConverting] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ shop: PublicShop }>(`/api/public/shops/${slug}`)
      .then((r) => {
        setShop(r.shop);
        if (getToken('student')) rememberShop(slug);
      })
      .catch(() => setError('This shop link is not valid.'));
  }, [slug]);

  useFileConversionRedirect(slug, loggedIn, converting, () => setConverting(null), setError);

  function onDropFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (shop?.open && e.dataTransfer.files.length > 0) void onFilesChosen(e.dataTransfer.files);
  }

  function onDragOverFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (shop?.open) setDragging(true);
  }

  async function onFilesChosen(files: FileList) {
    setUploading(true);
    setError('');
    try {
      const formData = new FormData();
      formData.append('shopSlug', slug);
      for (const f of Array.from(files)) formData.append('files', f);
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

  const cheapest = shop.options.papers[0];

  return (
    <div className="page">
      <Topbar right={loggedIn ? <Link to="/home">Home</Link> : undefined} />
      <h1>{shop.name}</h1>
      <p className="dim">
        {shop.address}
        {shop.campusName ? ` · ${shop.campusName}` : ''}
      </p>
      <div className="row">
        <span className={`stamp ${shop.open ? 'green' : 'red'}`}>{shop.open ? 'taking jobs' : 'closed'}</span>
        {cheapest && <span className="dim mono">{cheapest.label} from {rupees(cheapest.bwPaise)}/page</span>}
        {shop.colorAvailable && <span className="stamp blue">colour</span>}
        {shop.rating.average != null && (
          <span className="dim mono">★ {shop.rating.average} · {shop.rating.count} rating{shop.rating.count === 1 ? '' : 's'}</span>
        )}
      </div>

      {!loggedIn ? (
        <PhoneLogin onDone={() => setLoggedIn(true)} />
      ) : converting ? (
        <div className="ticket">
          <div className="eyebrow">preparing preview</div>
          <div className="ticket-num" aria-hidden>…</div>
          <div className="sub">Converting to a print-ready PDF. What you'll see is exactly what prints.</div>
        </div>
      ) : (
        <div
          className={`card stack${dragging ? ' dragging' : ''}`}
          onDragOver={onDragOverFiles}
          onDragLeave={() => setDragging(false)}
          onDrop={onDropFiles}
        >
          <div>
            <h2 style={{ margin: '0 0 2px' }}>Send files to print</h2>
            <p className="dim" style={{ margin: 0 }}>
              Pick one or many — PDF, Word, JPG, PNG — or drag them in. Several files print together
              as one job.
            </p>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept=".pdf,.docx,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void onFilesChosen(e.target.files);
            }}
          />
          <input
            ref={cameraInput}
            type="file"
            accept="image/*"
            capture="environment"
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) void onFilesChosen(e.target.files);
            }}
          />
          <div className="row">
            <button disabled={uploading || !shop.open} onClick={() => fileInput.current?.click()}>
              {uploading ? 'Uploading…' : 'Choose files'}
            </button>
            <button className="ghost" disabled={uploading || !shop.open} onClick={() => cameraInput.current?.click()}>
              Scan with camera
            </button>
          </div>
          {!shop.open && <NotifyWhenOpen slug={slug} />}
          {error && <div className="error">{error}</div>}
        </div>
      )}
    </div>
  );
}
