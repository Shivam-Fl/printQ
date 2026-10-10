import { Link } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';

export default function NotFound() {
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
