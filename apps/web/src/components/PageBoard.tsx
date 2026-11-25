/**
 * Everything that draws PDF pages (pdf.js, ~400 KB) lives in this one lazily
 * loaded module: the page board (every page of the order, tap to skip or
 * print it), the large page viewer, and the small first-page thumbnails of the
 * file list. One document cache is shared by all of them, so each file is
 * fetched once.
 *
 * Browsers (iOS Safari, Android Chrome) do not reliably show a PDF in an
 * <iframe>, so pages are drawn on canvases, and only while near the screen.
 * The bytes are fetched with the Authorization header: nothing sensitive is
 * ever put in a URL. "Open full PDF" asks the API for a 2-minute single-file
 * link and opens it with no referrer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PageRangeError } from '@printq/shared';
import { api, fetchBytes } from '../api.js';
import { PREVIEW_ZOOM_STEPS } from '../lib/previewPages.js';
import {
  excludedFromRange,
  isExcluded,
  orderPages,
  partSelectedCount,
  rangeText,
  selectedCount,
  setAllPages,
  setPartPages,
  togglePage,
  totalPages,
  type DocPart,
  type Excluded,
  type PageRef,
} from '../lib/pageSelection.js';
import { IconCheck, IconChevron, IconChevronLeft, IconClose, IconExpand } from './Icons.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

// ---------------------------------------------------------------- document cache

interface Entry {
  task: PDFDocumentLoadingTask | null;
  promise: Promise<PDFDocumentProxy>;
  users: number;
  lastUsed: number;
}

const KEEP_UNUSED = 6;
const docs = new Map<string, Entry>();

function acquire(fileId: string): Promise<PDFDocumentProxy> {
  let entry = docs.get(fileId);
  if (!entry) {
    const created: Entry = { task: null, users: 0, lastUsed: Date.now(), promise: Promise.resolve(null as never) };
    created.promise = (async () => {
      const bytes = await fetchBytes(`/api/files/${fileId}/preview/data`, 'student');
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
      created.task = task;
      return task.promise;
    })();
    // a failed load is not cached: the next viewer tries again
    created.promise.catch(() => {
      if (docs.get(fileId) === created) docs.delete(fileId);
    });
    docs.set(fileId, created);
    entry = created;
  }
  entry.users += 1;
  entry.lastUsed = Date.now();
  return entry.promise;
}

function release(fileId: string): void {
  const entry = docs.get(fileId);
  if (!entry) return;
  entry.users = Math.max(0, entry.users - 1);
  entry.lastUsed = Date.now();
  const unused = [...docs.entries()].filter(([, e]) => e.users === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  while (unused.length > KEEP_UNUSED) {
    const [id, old] = unused.shift()!;
    docs.delete(id);
    void old.task?.destroy();
  }
}

/** The loaded document of a file (shared), or its failure. */
function usePdf(fileId: string | null): { doc: PDFDocumentProxy | null; failed: boolean } {
  const [state, setState] = useState<{ id: string | null; doc: PDFDocumentProxy | null; failed: boolean }>({ id: null, doc: null, failed: false });
  useEffect(() => {
    if (!fileId) return;
    let active = true;
    acquire(fileId)
      .then((doc) => active && setState({ id: fileId, doc, failed: false }))
      .catch(() => active && setState({ id: fileId, doc: null, failed: true }));
    return () => {
      active = false;
      release(fileId);
    };
  }, [fileId]);
  return state.id === fileId ? { doc: state.doc, failed: state.failed } : { doc: null, failed: false };
}

// ---------------------------------------------------------------- one page on a canvas

const A4_ASPECT = 1.414;

/**
 * Draws one page at `width` CSS pixels once it is near the screen (or at
 * once when `eager`), and frees the bitmap again when it scrolls far away.
 * The viewport is the observer root: it also honours the clipping of a
 * scrolling list, and works when the list flows with the page on phones.
 */
function PageCanvas({ doc, page, width, eager = false, label }: {
  doc: PDFDocumentProxy;
  page: number;
  width: number;
  eager?: boolean;
  label: string;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [aspect, setAspect] = useState(A4_ASPECT);
  const [drawn, setDrawn] = useState(false);

  useEffect(() => {
    const el = holder.current;
    if (!el || eager || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      rootMargin: '600px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [eager]);

  useEffect(() => {
    if (!near) {
      const c = canvas.current;
      if (c) { c.width = 0; c.height = 0; }
      setDrawn(false);
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    let pdfPage: PDFPageProxy | null = null;
    (async () => {
      try {
        pdfPage = await doc.getPage(page);
        const base = pdfPage.getViewport({ scale: 1 });
        if (cancelled) return;
        setAspect(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = pdfPage.getViewport({ scale: (width / base.width) * dpr });
        const el = canvas.current;
        const ctx = el?.getContext('2d');
        if (!el || !ctx) return;
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        task = pdfPage.render({ canvasContext: ctx, viewport, canvas: el });
        await task.promise;
        if (!cancelled) setDrawn(true);
      } catch {
        /* a cancelled render rejects; a real failure leaves the blank sheet */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      pdfPage?.cleanup();
    };
  }, [near, doc, page, width]);

  return (
    <div ref={holder} className={`sheet${drawn ? ' drawn' : ''}`} style={{ aspectRatio: `1 / ${aspect}` }}>
      <canvas ref={canvas} role="img" aria-label={label} />
    </div>
  );
}

// ---------------------------------------------------------------- first-page thumbnail (file list)

/** Page 1 of a ready file, small; nothing until it has loaded. */
export function FirstPageThumb({ fileId, name }: { fileId: string; name: string }) {
  const { doc } = usePdf(fileId);
  if (!doc) return null;
  return <PageCanvas doc={doc} page={1} width={56} eager label={`First page of ${name}`} />;
}

// ---------------------------------------------------------------- "Open full PDF"

function useOpenFull(fileId: string | null) {
  const [opening, setOpening] = useState(false);
  const open = useCallback(async () => {
    if (!fileId) return;
    setOpening(true);
    // open the tab inside the click (popup blockers), then point it at the link
    const tab = window.open('about:blank', '_blank');
    try {
      const { url } = await api<{ url: string }>(`/api/files/${fileId}/preview-link`, { method: 'POST', role: 'student' });
      const href = new URL(url, window.location.origin).toString();
      if (tab) {
        tab.opener = null;
        tab.location.href = href;
      } else {
        window.location.assign(href);
      }
    } catch {
      tab?.close();
    } finally {
      setOpening(false);
    }
  }, [fileId]);
  return { open, opening };
}

// ---------------------------------------------------------------- the page board

export interface PendingFile {
  key: string;
  name: string;
  status: 'uploading' | 'preparing' | 'failed';
}

interface BoardProps {
  parts: DocPart[];
  /** files added but not ready yet, shown as placeholders after the ready ones */
  pending: PendingFile[];
  excluded: Excluded;
  onChange: (excluded: Excluded) => void;
  /** black & white chosen: show the pages that way too */
  grayscale: boolean;
  /** the joined, print-ready document (for "Open full PDF"), once ready */
  docFileId: string | null;
}

/**
 * Every page of the order, grouped by file, in print order. Tap a page to
 * skip it (or print it again); the expand button opens it large. A typed
 * range ("1-5, 8") is the fast path for long documents.
 */
export default function PageBoard({ parts, pending, excluded, onChange, grayscale, docFileId }: BoardProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [viewing, setViewing] = useState<number | null>(null); // index into `pages`
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [typedError, setTypedError] = useState('');
  const pages = useMemo(() => orderPages(parts), [parts]);
  const total = totalPages(parts);
  const chosen = selectedCount(parts, excluded);
  const { open, opening } = useOpenFull(docFileId);
  const waiting = pending.filter((p) => p.status !== 'failed');

  function applyTyped() {
    const value = typed.trim();
    if (!value) {
      onChange({});
      setTypedError('');
      setTyping(false);
      return;
    }
    try {
      onChange(excludedFromRange(parts, value));
      setTypedError('');
      setTyping(false);
    } catch (err) {
      setTypedError(err instanceof PageRangeError ? err.message : 'Those pages are not in this order.');
    }
  }

  const summary = total === 0
    ? 'Your pages appear here as soon as your files are ready.'
    : chosen === total
      ? `All ${total} page${total === 1 ? '' : 's'} will print. Tap a page to skip it.`
      : chosen === 0
        ? 'No pages selected. Tap the pages you want to print.'
        : `${chosen} of ${total} pages will print. Tap a page to skip or add it.`;

  let groupStart = 0;
  return (
    <section className="pages-card" aria-labelledby="pages-title">
      <header className="pages-head">
        <div className="pages-title-row">
          <h2 id="pages-title">Pages</h2>
          {total > 0 && <span className={`pages-count${chosen === 0 ? ' none' : ''}`}>{chosen}/{total}</span>}
        </div>
        <p className="pages-summary" aria-live="polite">{summary}</p>
        {total > 0 && (
          <div className="pages-tools">
            <button type="button" className="chip" onClick={() => onChange(setAllPages(parts, true))} disabled={chosen === total}>Select all</button>
            <button type="button" className="chip" onClick={() => onChange(setAllPages(parts, false))} disabled={chosen === 0}>Clear</button>
            <button
              type="button"
              className={`chip${typing ? ' on' : ''}`}
              aria-expanded={typing}
              disabled={waiting.length > 0}
              onClick={() => {
                setTyped(rangeText(parts, excluded));
                setTypedError('');
                setTyping((t) => !t);
              }}
            >
              Type page numbers
            </button>
          </div>
        )}
        {typing && (
          <form className="pages-type" onSubmit={(e) => { e.preventDefault(); applyTyped(); }}>
            <label htmlFor="typed-pages">Pages to print, counted across all files (1–{total})</label>
            <div className="row nowrap">
              <input
                id="typed-pages"
                type="text"
                inputMode="text"
                autoComplete="off"
                placeholder="For example: 1-5, 8, 11-14"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                aria-invalid={typedError ? true : undefined}
                aria-describedby={typedError ? 'typed-pages-error' : 'typed-pages-help'}
                autoFocus
              />
              <button type="submit" className="secondary">Apply</button>
            </div>
            {typedError
              ? <p id="typed-pages-error" className="field-error" role="alert">{typedError}</p>
              : <p id="typed-pages-help" className="field-help">Leave it empty to print every page.</p>}
          </form>
        )}
      </header>

      <div ref={scroller} className={`pages-scroller${grayscale ? ' bw' : ''}`} tabIndex={-1}>
        {parts.length === 0 && waiting.length === 0 && (
          <div className="pages-empty">Add a file to see its pages here.</div>
        )}
        {parts.map((part, partIndex) => {
          const start = groupStart;
          groupStart += part.pages;
          const selected = partSelectedCount(part, excluded);
          return (
            <PartGroup
              key={part.fileId}
              part={part}
              index={partIndex}
              multi={parts.length + waiting.length > 1}
              selected={selected}
              excluded={excluded}
              onToggle={(page) => onChange(togglePage(excluded, part.fileId, page))}
              onWhole={(include) => onChange(setPartPages(excluded, part, include))}
              onView={(page) => setViewing(start + page - 1)}
            />
          );
        })}
        {waiting.map((file) => (
          <div key={file.key} className="pages-group pending">
            <div className="pages-group-head">
              <span className="pages-file">{file.name}</span>
              <span className="pages-file-meta"><span className="spinner" aria-hidden /> {file.status === 'uploading' ? 'Uploading…' : 'Preparing pages…'}</span>
            </div>
            <div className="pages-grid" aria-hidden>
              <div className="page-tile placeholder"><div className="sheet" /></div>
              <div className="page-tile placeholder"><div className="sheet" /></div>
            </div>
          </div>
        ))}
      </div>

      {(grayscale || docFileId) && total > 0 && (
        <footer className="pages-foot">
          {grayscale ? <span>Shown in black &amp; white, as it will print.</span> : <span>Shown as it will print.</span>}
          {docFileId && (
            <button type="button" className="text-button" onClick={() => void open()} disabled={opening}>
              {opening ? 'Opening…' : 'Open full PDF'}
            </button>
          )}
        </footer>
      )}

      {viewing !== null && pages[viewing] && (
        <PageViewer
          pages={pages}
          parts={parts}
          index={viewing}
          excluded={excluded}
          grayscale={grayscale}
          onIndex={setViewing}
          onToggle={(ref) => onChange(togglePage(excluded, ref.fileId, ref.page))}
          onClose={() => setViewing(null)}
        />
      )}
    </section>
  );
}

function PartGroup({ part, index, multi, selected, excluded, onToggle, onWhole, onView }: {
  part: DocPart;
  index: number;
  multi: boolean;
  selected: number;
  excluded: Excluded;
  onToggle: (page: number) => void;
  onWhole: (include: boolean) => void;
  onView: (page: number) => void;
}) {
  const { doc, failed } = usePdf(part.fileId);
  const all = selected === part.pages;
  return (
    <div className="pages-group">
      <div className="pages-group-head">
        {multi && <span className="file-order" aria-hidden>{index + 1}</span>}
        <span className="pages-file" title={part.name}>{part.name}</span>
        <span className="pages-file-meta">{all ? `${part.pages} page${part.pages === 1 ? '' : 's'}` : `${selected} of ${part.pages}`}</span>
        {part.pages > 1 && (
          <button type="button" className="quiet small-quiet" onClick={() => onWhole(!all)}>
            {all ? 'Skip file' : 'Select file'}
          </button>
        )}
      </div>
      {failed ? (
        <p className="pages-failed">We couldn’t show these pages here. Your file is fine; use “Open full PDF” to check it.</p>
      ) : (
        <ul className="pages-grid">
          {Array.from({ length: part.pages }, (_, i) => i + 1).map((page) => {
            const skipped = isExcluded(excluded, part.fileId, page);
            const label = `${part.name}, page ${page}`;
            return (
              <li key={page} className={`page-tile${skipped ? ' skipped' : ''}`}>
                <button
                  type="button"
                  className="page-pick"
                  aria-pressed={!skipped}
                  aria-label={`${label}: ${skipped ? 'skipped, tap to print it' : 'printing, tap to skip it'}`}
                  onClick={() => onToggle(page)}
                >
                  {doc ? <PageCanvas doc={doc} page={page} width={180} label={label} /> : <div className="sheet" />}
                  <span className="page-mark" aria-hidden>{skipped ? null : <IconCheck />}</span>
                  <span className="page-no" aria-hidden>{page}</span>
                  {skipped && <span className="page-skipped" aria-hidden>Skipped</span>}
                </button>
                <button type="button" className="page-zoom" aria-label={`View ${label} large`} onClick={() => onView(page)}>
                  <IconExpand />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the large viewer

function PageViewer({ pages, parts, index, excluded, grayscale, onIndex, onToggle, onClose }: {
  pages: PageRef[];
  parts: DocPart[];
  index: number;
  excluded: Excluded;
  grayscale: boolean;
  onIndex: (index: number) => void;
  onToggle: (ref: PageRef) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<(typeof PREVIEW_ZOOM_STEPS)[number]>(1);
  const [width, setWidth] = useState(0);
  const ref = pages[index]!;
  const part = parts[ref.partIndex]!;
  const { doc, failed } = usePdf(ref.fileId);
  const skipped = isExcluded(excluded, ref.fileId, ref.page);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const opener = document.activeElement as HTMLElement | null;
    if (typeof el.showModal === 'function' && !el.open) el.showModal();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, Math.min(el.clientWidth - 32, (el.clientHeight - 32) / A4_ASPECT)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const go = useCallback((delta: number) => {
    const next = index + delta;
    if (next >= 0 && next < pages.length) {
      onIndex(next);
      setZoom(1);
    }
  }, [index, pages.length, onIndex]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  return (
    <dialog
      ref={dialog}
      className="page-viewer"
      aria-label={`${part.name}, page ${ref.page}`}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === dialog.current) onClose(); }}
    >
      <div className="viewer-top">
        <div className="viewer-title">
          <strong title={part.name}>{part.name}</strong>
          <span>Page {ref.page} of {part.pages}{parts.length > 1 ? ` · ${ref.docPage} of ${pages.length} in this order` : ''}</span>
        </div>
        <div className="viewer-zoom" role="group" aria-label="Zoom">
          <button type="button" className="ghost small" aria-label="Zoom out" disabled={zoom === PREVIEW_ZOOM_STEPS[0]}
            onClick={() => setZoom((z) => PREVIEW_ZOOM_STEPS[Math.max(0, PREVIEW_ZOOM_STEPS.indexOf(z) - 1)]!)}>−</button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button type="button" className="ghost small" aria-label="Zoom in" disabled={zoom === PREVIEW_ZOOM_STEPS[PREVIEW_ZOOM_STEPS.length - 1]}
            onClick={() => setZoom((z) => PREVIEW_ZOOM_STEPS[Math.min(PREVIEW_ZOOM_STEPS.length - 1, PREVIEW_ZOOM_STEPS.indexOf(z) + 1)]!)}>+</button>
        </div>
        <button type="button" className="ghost viewer-close" aria-label="Close" onClick={onClose}><IconClose /></button>
      </div>

      <div ref={body} className={`viewer-body${grayscale ? ' bw' : ''}${skipped ? ' skipped' : ''}`}>
        {failed && <p className="viewer-status">We couldn’t show this page here.</p>}
        {!failed && !doc && <p className="viewer-status" role="status">Loading page…</p>}
        {doc && width > 0 && (
          <div className="viewer-page" style={{ width: Math.floor(width * zoom) }}>
            <PageCanvas key={`${ref.fileId}-${ref.page}`} doc={doc} page={ref.page} width={Math.floor(width * zoom)} eager label={`${part.name}, page ${ref.page}`} />
            {skipped && <span className="viewer-skipped">Skipped</span>}
          </div>
        )}
      </div>

      <div className="viewer-bottom">
        <button type="button" className="ghost" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous page">
          <IconChevronLeft /> <span className="viewer-nav-label">Previous</span>
        </button>
        <button type="button" className={skipped ? 'secondary viewer-toggle' : 'viewer-toggle'} aria-pressed={!skipped} onClick={() => onToggle(ref)}>
          {skipped ? 'Skipped · tap to print' : <><IconCheck /> Printing this page</>}
        </button>
        <button type="button" className="ghost" onClick={() => go(1)} disabled={index === pages.length - 1} aria-label="Next page">
          <span className="viewer-nav-label">Next</span> <IconChevron />
        </button>
      </div>
    </dialog>
  );
}
