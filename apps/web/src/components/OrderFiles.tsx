import { Suspense, lazy, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { FILE_ACCEPT, MAX_ORDER_FILES, formatBytes } from '../lib/fileChoice.js';
import { addFiles, dismissNotice, moveItem, removeItem, retryItem, type Draft, type DraftItem } from '../lib/orderDraft.js';
import { partSelectedCount, type Excluded } from '../lib/pageSelection.js';
import { IconArrowDown, IconArrowUp, IconCamera, IconClose, IconFileText, IconImage, IconPlus, IconRetry } from './Icons.js';

const FirstPageThumb = lazy(() => import('./PageBoard.js').then((m) => ({ default: m.FirstPageThumb })));

/** The two hidden pickers (files, camera) and the buttons that open them. */
export function useFilePickers(onFiles: (files: File[]) => void) {
  const files = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const take = (input: HTMLInputElement) => {
    const chosen = input.files ? Array.from(input.files) : [];
    input.value = ''; // picking the same file again must fire change again
    if (chosen.length > 0) onFiles(chosen);
  };
  const inputs: ReactNode = (
    <>
      <input ref={files} type="file" multiple accept={FILE_ACCEPT} hidden onChange={(e) => take(e.currentTarget)} />
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => take(e.currentTarget)} />
    </>
  );
  return { inputs, chooseFiles: () => files.current?.click(), takePhoto: () => camera.current?.click() };
}

/**
 * Accept files dropped anywhere on an element (desktop). A drop is always
 * caught, even when files cannot be added, so the browser never navigates
 * away to show the dropped PDF instead of the app.
 */
export function useFileDrop(enabled: boolean, onFiles: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return {
    dragging,
    handlers: {
      onDragEnter: (e: DragEvent<HTMLElement>) => {
        if (!enabled || !hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragOver: (e: DragEvent<HTMLElement>) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDragging(false);
        if (!enabled) return;
        const dropped = Array.from(e.dataTransfer.files ?? []);
        if (dropped.length > 0) onFiles(dropped);
      },
    },
  };
}

function KindIcon({ item }: { item: DraftItem }) {
  return item.kind === 'image' ? <IconImage /> : <IconFileText />;
}

function Thumb({ item }: { item: DraftItem }) {
  if (item.localThumb) return <img src={item.localThumb} alt="" />;
  if (item.status === 'ready' && item.fileId) {
    return (
      <Suspense fallback={<KindIcon item={item} />}>
        <FirstPageThumb fileId={item.fileId} name={item.name} />
      </Suspense>
    );
  }
  return <KindIcon item={item} />;
}

function statusLine(item: DraftItem, excluded: Excluded): ReactNode {
  const size = item.size ? formatBytes(item.size) : null;
  if (item.status === 'uploading') {
    const pct = Math.round(item.progress * 100);
    return (
      <>
        <span>{pct >= 100 ? 'Upload done, checking…' : `Uploading… ${pct}%`}</span>
        <span className="file-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Uploading ${item.name}`}>
          <span style={{ width: `${Math.max(4, pct)}%` }} />
        </span>
      </>
    );
  }
  if (item.status === 'preparing') return <span><span className="spinner" aria-hidden /> Preparing pages…</span>;
  if (item.status === 'failed') return <span className="file-error">{item.error}</span>;
  const pages = item.pages ?? 0;
  const chosen = item.fileId ? partSelectedCount({ fileId: item.fileId, name: item.name, pages }, excluded) : pages;
  const pageText = chosen === pages ? `${pages} page${pages === 1 ? '' : 's'}` : `${chosen} of ${pages} pages`;
  return <span>{[pageText, size].filter(Boolean).join(' · ')}</span>;
}

/**
 * The files in this order, in print order: add more at any time (button, camera
 * or drop), remove, or move a file up or down. Each row shows its own progress
 * and, if something is wrong with that file, why.
 */
export default function OrderFiles({ slug, draft, dragging = false }: { slug: string; draft: Draft; dragging?: boolean }) {
  const items = draft.items;
  const full = items.length >= MAX_ORDER_FILES;
  const { inputs, chooseFiles, takePhoto } = useFilePickers((files) => addFiles(slug, files));
  const totalPages = items.reduce((sum, it) => sum + (it.status === 'ready' ? it.pages ?? 0 : 0), 0);

  return (
    <section className={`checkout-card files-card${dragging ? ' dragging' : ''}`} aria-labelledby="files-title">
      <div className="files-head">
        <div>
          <h2 id="files-title">Files</h2>
          <p className="dim">
            {items.length === 0
              ? 'Add the files you want printed.'
              : `${items.length} file${items.length === 1 ? '' : 's'}${totalPages ? ` · ${totalPages} page${totalPages === 1 ? '' : 's'}` : ''} · printed in this order`}
          </p>
        </div>
      </div>

      {draft.notice && (
        <div className="files-notice" role="status">
          <span>{draft.notice}</span>
          <button type="button" className="quiet" onClick={() => dismissNotice(slug)}>OK</button>
        </div>
      )}

      {items.length > 0 && (
        <ol className="file-list">
          {items.map((item, index) => (
            <li key={item.key} className={`file-row ${item.status}`}>
              {items.length > 1 && <span className="file-order" aria-hidden>{index + 1}</span>}
              <span className="file-thumb" aria-hidden><Thumb item={item} /></span>
              <div className="file-body">
                <strong className="file-name" title={item.name}>{item.name}</strong>
                <span className="file-meta">{statusLine(item, draft.excluded)}</span>
              </div>
              <div className="file-actions">
                {item.status === 'failed' && item.retryFile && (
                  <button type="button" className="icon-button" aria-label={`Upload ${item.name} again`} onClick={() => retryItem(slug, item.key)}>
                    <IconRetry />
                  </button>
                )}
                {items.length > 1 && (
                  <>
                    <button type="button" className="icon-button" aria-label={`Move ${item.name} up`} disabled={index === 0} onClick={() => moveItem(slug, item.key, -1)}>
                      <IconArrowUp />
                    </button>
                    <button type="button" className="icon-button" aria-label={`Move ${item.name} down`} disabled={index === items.length - 1} onClick={() => moveItem(slug, item.key, 1)}>
                      <IconArrowDown />
                    </button>
                  </>
                )}
                <button type="button" className="icon-button remove" aria-label={`Remove ${item.name}`} onClick={() => removeItem(slug, item.key)}>
                  <IconClose />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {inputs}
      <div className="files-add">
        <button type="button" className="secondary" onClick={chooseFiles} disabled={full}>
          <IconPlus /> {items.length === 0 ? 'Choose files' : 'Add more files'}
        </button>
        <button type="button" className="ghost" onClick={takePhoto} disabled={full}>
          <IconCamera /> Take a photo
        </button>
        <span className="files-hint">
          {full ? `That’s the limit: ${MAX_ORDER_FILES} files per order.` : 'PDF, Word or photos, up to 25 MB each. You can also drop files here.'}
        </span>
      </div>
    </section>
  );
}
