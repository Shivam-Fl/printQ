import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { api, fetchBytes } from '../api.js';
import { PREVIEW_ZOOM_STEPS, previewPageWidth, selectedPreviewPages } from '../lib/previewPages.js';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  fileId: string;
  /** Total pages of the converted document. */
  totalPages: number | null;
  /** The order's selected range, or null for the whole document. */
  pageRange: string | null;
}

type Phase = 'loading' | 'ready' | 'failed';

/**
 * Mobile-safe PDF preview. Browsers (iOS Safari, Android Chrome, headless
 * Chromium) do not reliably render a PDF inside an <iframe>, so pages are drawn
 * to canvases with pdf.js instead: first page immediately, the rest as they
 * scroll into view, limited to the pages that will actually print.
 *
 * Security: the bytes are fetched with the Authorization header (nothing
 * sensitive is ever placed in a URL). The "Open full PDF" fallback asks the
 * API for a 2-minute single-file link and opens it with no referrer.
 */
export default function PdfPreview({ fileId, totalPages, pageRange }: Props) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [zoom, setZoom] = useState<(typeof PREVIEW_ZOOM_STEPS)[number]>(1);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  // load the document once per file
  useEffect(() => {
    const controller = new AbortController();
    let loadingTask: PDFDocumentLoadingTask | null = null;
    setPhase('loading');
    setDoc(null);
    (async () => {
      try {
        const bytes = await fetchBytes(`/api/files/${fileId}/preview/data`, 'student', controller.signal);
        const task = pdfjs.getDocument({ data: new Uint8Array(bytes) });
        loadingTask = task;
        const loaded = await task.promise;
        if (controller.signal.aborted) {
          void task.destroy();
          return;
        }
        setDoc(loaded);
        setPhase('ready');
      } catch {
        if (!controller.signal.aborted) setPhase('failed');
      }
    })();
    return () => {
      controller.abort();
      // pdf.js 6: teardown lives on the loading task (frees the document and its worker)
      if (loadingTask) void loadingTask.destroy();
    };
  }, [fileId]);

  // track the container width so pages fit it (and re-render when it changes)
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

  const pageNumbers = useMemo(
    () => selectedPreviewPages(doc?.numPages ?? totalPages ?? 0, pageRange),
    [doc, totalPages, pageRange],
  );

  const [opening, setOpening] = useState(false);
  const openFull = useCallback(async () => {
    setOpening(true);
    // Open the tab inside the click (popup blockers), then point it at the link.
    const tab = window.open('about:blank', '_blank');
    try {
      const { url } = await api<{ url: string }>(`/api/files/${fileId}/preview-link`, {
        method: 'POST',
        role: 'student',
      });
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

  return (
    <div className="pdf-preview">
      {phase === 'ready' && (
        <div className="pdf-toolbar" role="group" aria-label="Preview zoom">
          <button
            type="button"
            className="ghost small"
            aria-label="Zoom out"
            disabled={zoom === PREVIEW_ZOOM_STEPS[0]}
            onClick={() => setZoom((z) => PREVIEW_ZOOM_STEPS[Math.max(0, PREVIEW_ZOOM_STEPS.indexOf(z) - 1)]!)}
          >−</button>
          <span aria-live="polite">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            className="ghost small"
            aria-label="Zoom in"
            disabled={zoom === PREVIEW_ZOOM_STEPS[PREVIEW_ZOOM_STEPS.length - 1]}
            onClick={() => setZoom((z) => PREVIEW_ZOOM_STEPS[Math.min(PREVIEW_ZOOM_STEPS.length - 1, PREVIEW_ZOOM_STEPS.indexOf(z) + 1)]!)}
          >+</button>
        </div>
      )}

      {phase === 'loading' && <div className="pdf-status" role="status">Preparing preview…</div>}
      {phase === 'failed' && (
        <div className="pdf-status" role="alert">
          <strong>We couldn’t show the preview here.</strong>
          <span>Your file is fine — open the full PDF to check it.</span>
        </div>
      )}

      {phase === 'ready' && doc && (
        <div className="pdf-scroller" ref={scroller} tabIndex={0} aria-label="Print preview pages">
          {pageNumbers.map((n, i) => (
            <PageSlot key={n} doc={doc} pageNumber={n} ordinal={i + 1} of={pageNumbers.length}
              width={previewPageWidth(Math.max(width - 2, 0) || 280, zoom)} eager={i === 0} root={scroller} />
          ))}
        </div>
      )}

      <div className="pdf-footer">
        <button type="button" className="text-button" onClick={() => void openFull()} disabled={opening}>
          {opening ? 'Opening…' : 'Open full PDF'}
        </button>
      </div>
    </div>
  );
}

interface SlotProps {
  doc: PDFDocumentProxy;
  pageNumber: number;
  ordinal: number;
  of: number;
  width: number;
  eager: boolean;
  root: React.RefObject<HTMLDivElement | null>;
}

/** One page: a sized placeholder that renders its canvas only while near the viewport. */
function PageSlot({ doc, pageNumber, ordinal, of, width, eager, root }: SlotProps) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(eager);
  const [aspect, setAspect] = useState(1.414);

  useEffect(() => {
    const el = holder.current;
    if (!el || eager) return;
    const io = new IntersectionObserver(([entry]) => setNear(Boolean(entry?.isIntersecting)), {
      root: root.current,
      rootMargin: '700px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, [eager, root]);

  useEffect(() => {
    if (!near) {
      // release the bitmap of pages far from the viewport (mobile memory)
      const c = canvas.current;
      if (c) { c.width = 0; c.height = 0; }
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    (async () => {
      try {
        page = await doc.getPage(pageNumber);
        const base = page.getViewport({ scale: 1 });
        if (cancelled) return;
        setAspect(base.height / base.width);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = page.getViewport({ scale: (width / base.width) * dpr });
        const el = canvas.current;
        const ctx = el?.getContext('2d');
        if (!el || !ctx) return;
        el.width = Math.floor(viewport.width);
        el.height = Math.floor(viewport.height);
        task = page.render({ canvasContext: ctx, viewport, canvas: el });
        await task.promise;
      } catch {
        /* a cancelled render rejects; a real failure leaves the placeholder */
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
      page?.cleanup();
    };
  }, [near, doc, pageNumber, width]);

  return (
    <div
      ref={holder}
      className="pdf-page"
      style={{ width, height: Math.round(width * aspect) }}
      data-page={pageNumber}
    >
      <canvas ref={canvas} style={{ width, height: Math.round(width * aspect) }} aria-label={`Page ${pageNumber}, ${ordinal} of ${of}`} role="img" />
      <span className="pdf-page-label" aria-hidden>{pageNumber}</span>
    </div>
  );
}
