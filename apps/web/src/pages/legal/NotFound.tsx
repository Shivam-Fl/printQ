import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import { hideFromSearch } from '../../lib/searchVisibility.js';

export { hideFromSearch };

export default function NotFound() {
  // SPA soft-404: tell crawlers not to index whatever URL landed here, and don't let
  // RouteMeta's canonical (set to every path) claim this mistyped URL is a real page.
  useEffect(() => hideFromSearch(document), []);
  return (
    <main className="page legal-page">
      <Topbar />
      <div className="notfound">
        <span className="notfound-code" aria-hidden>404</span>
        <h1>This page is not in the queue</h1>
        <p>The link may be old or mistyped. Head back and pick up from there.</p>
        <div className="welcome-actions">
          <Link to="/" className="button-link large">Go to Home</Link>
          <Link to="/shops" className="button-link secondary large">Find a shop</Link>
        </div>
        <p className="dim"><Link to="/support">Help &amp; policies</Link></p>
      </div>
    </main>
  );
}
