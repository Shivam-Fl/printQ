import path from 'node:path';
import express, { type RequestHandler } from 'express';

/** Paths the API host always answers itself: the API, the health check and sockets. */
const API_HOST_PATH = /^\/(api|healthz|socket\.io)(\/|$)/i;

/**
 * PA-7: split-domain production (web on printqs.com, API on api.printqs.com).
 * A page opened on any other host (api.printqs.com/pc, the Render URL) gets a
 * 301 to the same path on the public web address, so owners and students only
 * ever see one site. Only GET/HEAD page loads move; API calls, webhooks, the
 * health check and socket.io are never redirected. A single-domain deploy
 * (PUBLIC_WEB_URL is this host) is untouched.
 */
export function redirectPagesToWebHost(publicWebUrl: string): RequestHandler {
  const web = new URL(publicWebUrl);
  const webHost = web.hostname.toLowerCase();
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (API_HOST_PATH.test(req.path) || !req.originalUrl.startsWith('/')) return next();
    if (!req.hostname || req.hostname.toLowerCase() === webHost) return next();
    // origin + path (never new URL(path, origin)): "//other.site" stays a path on the web host
    res.redirect(301, `${web.origin}${req.originalUrl}`);
  };
}

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
