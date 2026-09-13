import { useEffect, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, getToken, rememberShop } from '../../api.js';
import { getStudentSocket } from '../../socket.js';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';

interface Paper {
  id: string;
  label: string;
  colorAvailable: boolean;
}
interface PublicShop {
  slug: string;
  name: string;
  address: string;
  campusName: string | null;
  open: boolean;
  colorAvailable: boolean;
  rating: { average: number | null; count: number };
  options: { papers: Paper[]; bindings: { id: string; label: string }[]; duplexEnabled: boolean };
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

  return (
    <div className="page">
      <Topbar right={loggedIn ? <Link to="/home">Home</Link> : undefined} />
      <div className="shop-hero">
        <div>
          <span className="eyebrow-label">Order online · collect at counter</span>
          <h1>{shop.name}</h1>
          <p className="dim">
            {shop.address}
            {shop.campusName ? ` · ${shop.campusName}` : ''}
          </p>
          <div className="shop-facts">
            {shop.options.papers.length > 0 && <span>{shop.options.papers.map((paper) => paper.label).join(' · ')}</span>}
            {shop.colorAvailable && <span>Colour available</span>}
            {shop.rating.average != null && (
              <span>★ {shop.rating.average} from {shop.rating.count} rating{shop.rating.count === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
        <span className={`stamp ${shop.open ? 'green' : 'red'}`}>{shop.open ? 'Taking orders' : 'Currently closed'}</span>
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
          className={`upload-panel${dragging ? ' dragging' : ''}${!shop.open ? ' closed' : ''}`}
          onDragOver={onDragOverFiles}
          onDragLeave={() => setDragging(false)}
          onDrop={onDropFiles}
        >
          <div>
            <div className="upload-mark" aria-hidden>↑</div>
            <h2>{shop.open ? 'Drop your files here' : 'Orders are paused'}</h2>
            <p>
              {shop.open
                ? 'Choose one or several documents. We combine them into one preview before you pay.'
                : 'This shop has no printer online right now. Ask to be notified when ordering resumes.'}
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
          {shop.open && (
            <>
              <div className="upload-actions">
                <button disabled={uploading} onClick={() => fileInput.current?.click()}>
                  {uploading ? 'Uploading safely…' : 'Choose files'}
                </button>
                <button className="ghost" disabled={uploading} onClick={() => cameraInput.current?.click()}>
                  Scan paper with camera
                </button>
              </div>
              <div className="upload-meta">PDF · DOCX · JPG · PNG · private files auto-delete</div>
            </>
          )}
          {!shop.open && <NotifyWhenOpen slug={slug} />}
          {error && <div className="error-box" role="alert">{error}</div>}
        </div>
      )}
    </div>
  );
}
