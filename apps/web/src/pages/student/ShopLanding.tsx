import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, api, getToken, rememberShop } from '../../api.js';
import { ErrorState, LoadingState } from '../../components/ResourceStates.js';
import { useResource } from '../../lib/useResource.js';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';
import { IconCamera, IconChevron, IconPlus, IconUpload } from '../../components/Icons.js';
import { useFileDrop, useFilePickers } from '../../components/OrderFiles.js';
import { addFiles, useOrderDraft } from '../../lib/orderDraft.js';
import { MAX_ORDER_FILES } from '../../lib/fileChoice.js';
import { hideFromSearch } from '../../lib/searchVisibility.js';

interface Paper {
  id: string;
  label: string;
  colorAvailable: boolean;
}
interface PublicShop {
  slug: string;
  name: string;
  address: string;
  open: boolean;
  temporarilyUnavailable?: boolean;
  colorAvailable: boolean;
  rating: { average: number | null; count: number };
  options: { papers: Paper[]; bindings: { id: string; label: string }[]; duplexEnabled: boolean };
}

function isShopResponse(value: unknown): value is { shop: PublicShop } {
  const shop = (value as { shop?: Partial<PublicShop> } | null)?.shop;
  return Boolean(shop && typeof shop.name === 'string' && typeof shop.slug === 'string' && shop.options && Array.isArray(shop.options.papers) && Array.isArray(shop.options.bindings) && shop.rating);
}

/** Self-contained: manages its own "requested" state so the parent doesn't need to. Signed-in students only. */
function NotifyWhenOpen({ slug }: { slug: string }) {
  const [requested, setRequested] = useState(false);
  return (
    <button
      type="button"
      className="ghost"
      disabled={requested}
      onClick={async () => {
        await api(`/api/public/shops/${slug}/notify-when-open`, { method: 'POST', role: 'student' }).catch(
          () => undefined,
        );
        setRequested(true);
      }}
    >
      {requested ? 'We’ll tell you when it opens' : 'Notify me when open'}
    </button>
  );
}

export default function ShopLanding() {
  const { slug = '' } = useParams();
  const validSlug = /^[a-z0-9][a-z0-9-]{0,79}$/i.test(slug);
  const [loggedIn, setLoggedIn] = useState(Boolean(getToken('student')));
  const navigate = useNavigate();
  const draft = useOrderDraft(slug);
  const inOrder = draft?.items.length ?? 0;

  const shopResource = useResource<{ shop: PublicShop }>(
    (signal) => api<{ shop: PublicShop }>(`/api/public/shops/${encodeURIComponent(slug)}`, { signal }),
    [slug],
    { enabled: validSlug, validate: isShopResponse },
  );
  const shop = shopResource.data?.shop ?? null;

  useEffect(() => {
    if (shop && getToken('student')) rememberShop(slug);
  }, [shop, slug]);

  // Chosen files start uploading at once and the student goes straight to the
  // order page, where each file shows its own progress and more can be added.
  const startOrder = (files: File[]) => {
    addFiles(slug, files);
    navigate(`/s/${slug}/order`);
  };
  const { inputs, chooseFiles, takePhoto } = useFilePickers(startOrder);
  const drop = useFileDrop(Boolean(shop?.open && loggedIn), startOrder);

  const notFound = !validSlug || (shopResource.status === 'error' && shopResource.error instanceof ApiError && shopResource.error.status === 404);
  // an unknown or unpublished shop link is a 404 for search engines too (no index, no self canonical)
  useEffect(() => (notFound ? hideFromSearch(document) : undefined), [notFound]);
  if (notFound) {
    // Never a dead end: a bad/unpublished link offers the directory and home.
    return (
      <div className="page">
        <Topbar />
        <div className="empty-state invalid-shop" role="alert">
          <strong>This shop link is not valid.</strong>
          <p>The link may be old, mistyped, or the shop is not taking orders on PrintQs yet.</p>
          <div className="row" style={{ justifyContent: 'center', marginTop: 8 }}>
            <Link to="/shops" className="button-link">Find a shop</Link>
            <Link to="/home" className="button-link secondary">Go home</Link>
          </div>
        </div>
      </div>
    );
  }
  if (!shop && shopResource.status === 'error') {
    return (
      <div className="page">
        <Topbar />
        <ErrorState onRetry={shopResource.retry} title="Could not load this shop" />
      </div>
    );
  }
  if (!shop) {
    return (
      <div className="page">
        <Topbar />
        <LoadingState status={shopResource.status} rows={2} />
      </div>
    );
  }

  return (
    <div className="page">
      <Topbar right={loggedIn ? <Link to="/home">Home</Link> : undefined} />
      <div className="shop-hero">
        <div>
          <span className="eyebrow-label">Order here, collect at the counter</span>
          {/* long names get a smaller size instead of being cut off (names can be up to 120 characters) */}
          <h1 className={shop.name.length > 28 ? 'long-name' : undefined}>{shop.name}</h1>
          <p className="dim">
            {shop.address}
          </p>
          <div className="shop-facts">
            {shop.options.papers.length > 0 && <span>{shop.options.papers.map((paper) => paper.label).join(' · ')}</span>}
            {shop.colorAvailable && <span>Colour available</span>}
            {shop.rating.average != null && (
              <span>★ {shop.rating.average} from {shop.rating.count} rating{shop.rating.count === 1 ? '' : 's'}</span>
            )}
          </div>
        </div>
        <span className={`stamp ${shop.open ? 'green' : 'red'}`}>{shop.open ? 'Taking orders' : shop.temporarilyUnavailable ? 'Unavailable' : 'Closed now'}</span>
      </div>

      {!loggedIn ? (
        <PhoneLogin onDone={() => setLoggedIn(true)} />
      ) : (
        <>
          {shop.open && inOrder > 0 && (
            <Link to={`/s/${slug}/order`} className="resume-order">
              <span>
                <strong>Your order here has {inOrder} file{inOrder === 1 ? '' : 's'}</strong>
                <span>Continue to pages and print settings</span>
              </span>
              <IconChevron />
            </Link>
          )}
          <div
            className={`upload-panel${drop.dragging ? ' dragging' : ''}${!shop.open ? ' closed' : ''}`}
            {...drop.handlers}
          >
            <div>
              <div className="upload-mark" aria-hidden><IconUpload /></div>
              <h2>{shop.open ? (inOrder > 0 ? 'Add more files' : 'Choose your files') : shop.temporarilyUnavailable ? 'This shop is temporarily unavailable' : 'Not taking orders right now'}</h2>
              <p>
                {shop.open
                  ? `PDF, Word or photos, up to ${MAX_ORDER_FILES} files. Next you can add more, set the order, pick pages and see every page before you order. You pay at the counter.`
                  : shop.temporarilyUnavailable
                    ? 'New orders are not available here right now. Please try again later or choose another shop.'
                    : 'This shop’s printer is not online. Try another shop nearby, or ask us to tell you when it opens.'}
              </p>
            </div>
            {shop.open && (
              <>
                {inputs}
                <div className="upload-actions">
                  <button type="button" onClick={chooseFiles}>
                    <IconPlus /> Choose files
                  </button>
                  <button type="button" className="ghost" onClick={takePhoto}>
                    <IconCamera /> Take a photo
                  </button>
                </div>
                <div className="upload-meta">Your files are private and deleted soon after printing. On a computer you can also drop them here.</div>
              </>
            )}
            {!shop.open && (
              // never a dead end: another shop is one tap away
              <div className="upload-actions">
                <Link to="/shops" className="button-link">Find another shop</Link>
                {!shop.temporarilyUnavailable && getToken('student') && <NotifyWhenOpen slug={slug} />}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
