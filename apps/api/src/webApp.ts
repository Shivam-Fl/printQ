import path from 'node:path';
import express from 'express';

/**
 * Single-domain production deploy: serve the built web app (PWA, push and API
 * share one origin). Existing files are served as-is; extension-less paths fall
 * back to index.html so client-side routes work. A path that LOOKS like a file
 * (`/robots.txt`, `/sitemap.xml`, `/assets/old-hash.js`) but doesn't exist must
 * 404 — returning the HTML shell for it makes crawlers and stale-asset loads
 * parse HTML as the wrong type.
 */
export function mountWebApp(app: express.Express, webDist: string): void {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (req, res, next) => {
    if (path.posix.basename(req.path).includes('.')) return next(); // file-like (also dotfiles)
    res.sendFile(path.join(webDist, 'index.html'));
  });
}
