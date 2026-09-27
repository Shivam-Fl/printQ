import { Link, useNavigate } from 'react-router-dom';
import { getToken } from '../../api.js';
import { IconPrinter, IconStore, IconChevron, IconClock, IconBell } from '../../components/Icons.js';
import { useEffect } from 'react';

export default function Welcome() {
  const navigate = useNavigate();

  useEffect(() => {
    if (getToken('student')) navigate('/home', { replace: true });
  }, [navigate]);

  return (
    <main className="welcome-page">
      <nav className="public-nav">
        <Link to="/" className="brand brand-large">Print<em>Q</em></Link>
        <div className="public-nav-links">
          <Link to="/shops">Find a shop</Link>
          <Link to="/dashboard/login">Shop sign in</Link>
        </div>
      </nav>

      <section className="welcome-layout">
        <div className="welcome-copy">
          <span className="eyebrow-label">Campus printing, without the crowd</span>
          <h1>Upload anywhere.<br />Queue on arrival.</h1>
          <p className="welcome-lede">
            Prepare your order anywhere. Pay at the shop by cash or the shop's own UPI. Your walk-in position starts only after you reach the shop.
          </p>
          <div className="welcome-actions">
            <Link to="/login" className="button-link large">Start a print <IconChevron /></Link>
            <Link to="/shops" className="button-link secondary large">Browse nearby shops</Link>
          </div>
          <div className="trust-row">
            <span><IconClock /> Arrival-based live line</span>
            <span><IconBell /> Turn alerts</span>
            <span><IconPrinter /> Exact PDF preview</span>
          </div>
        </div>

        <div className="queue-demo" aria-label="Example PrintQ order status">
          <div className="queue-demo-head">
            <div>
              <span className="queue-demo-kicker">CURRENT ORDER</span>
              <strong>Assignment-final.pdf</strong>
            </div>
            <span className="status-dot done">Checked in</span>
          </div>
          <div className="queue-number">
            <span>Your position</span>
            <strong>03</strong>
            <small>about 8 minutes</small>
          </div>
          <div className="queue-route">
            <div className="done"><i />Order prepared</div>
            <div className="active"><i />Checked in on arrival</div>
            <div><i />Pay at counter, then print</div>
          </div>
          <div className="queue-tip">Upload at home. Join the line only when you are physically at the shop.</div>
        </div>
      </section>

      <section className="role-section">
        <div className="section-heading public-section-heading">
          <div>
            <span className="eyebrow-label">One platform, two simple experiences</span>
            <h2>Built for both sides of the counter</h2>
          </div>
        </div>
        <div className="role-grid">
          <Link to="/login" className="role-card">
            <span className="role-icon"><IconPrinter /></span>
            <div>
              <span className="role-label">For students</span>
              <h3>Send a print</h3>
              <p>Upload and configure remotely, then pay at the shop and track your print.</p>
              <span className="role-link">Continue with phone <IconChevron /></span>
            </div>
          </Link>
          <Link to="/dashboard/login" className="role-card owner-role">
            <span className="role-icon"><IconStore /></span>
            <div>
              <span className="role-label">For print shops</span>
              <h3>Run your queue</h3>
              <p>Prepared orders stay separate from checked-in students. One code finds the right order and confirms cash or UPI when received.</p>
              <span className="role-link">Open shop dashboard <IconChevron /></span>
            </div>
          </Link>
        </div>
      </section>

      <footer className="public-footer">
        <span>PrintQ</span>
        <span>Less waiting. Better printing.</span>
        <Link to="/shops">Find a verified shop</Link>
      </footer>
    </main>
  );
}
