import type { ResourceStatus } from '../lib/useResource.js';

/** Friendly copy shared by every data screen. */
export function statusMessage(status: ResourceStatus): string {
  if (status === 'slow') return 'Waking up the server — this can take up to a minute on first visit.';
  if (status === 'retrying') return 'Having trouble connecting — trying again…';
  return 'Loading…';
}

/** Loading placeholder: reserves list space (no layout shift) and explains long waits. */
export function LoadingState({ status, rows = 3 }: { status: ResourceStatus; rows?: number }) {
  return (
    <div className="resource-loading" role="status" aria-live="polite">
      <div className="skeleton-list" aria-hidden>
        {Array.from({ length: rows }, (_, i) => <div className="skeleton-card" key={i} />)}
      </div>
      <p className="dim resource-loading-note">{statusMessage(status)}</p>
    </div>
  );
}

/** Failed (not empty): says so plainly and offers a retry. */
export function ErrorState({ onRetry, title = 'We could not load this', detail }: {
  onRetry: () => void;
  title?: string;
  detail?: string;
}) {
  return (
    <div className="empty-state resource-error" role="alert">
      <strong>{title}</strong>
      <p>{detail ?? 'Check your connection and try again. If it keeps happening, the server may be restarting — give it a minute.'}</p>
      <button type="button" onClick={onRetry} style={{ marginTop: 14 }}>Try again</button>
    </div>
  );
}
