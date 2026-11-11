/**
 * Adds <meta name="robots" content="noindex"> and takes the canonical link out while the 404 is
 * shown. Returns the undo (put the canonical back for the next page). This runs after RouteMeta's
 * effect, which is an earlier sibling in App, so the canonical it just set is the one removed.
 */
export function hideFromSearch(doc: Document): () => void {
  const meta = doc.createElement('meta');
  meta.name = 'robots';
  meta.content = 'noindex';
  doc.head.appendChild(meta);
  const canonical = doc.querySelector('link[rel="canonical"]');
  canonical?.remove();
  return () => {
    meta.remove();
    if (canonical && !canonical.isConnected) doc.head.appendChild(canonical);
  };
}
