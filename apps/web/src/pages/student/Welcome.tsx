import { Link, useNavigate } from 'react-router-dom';
import { getToken } from '../../api.js';
import { IconPrinter, IconStore, IconChevron } from '../../components/Icons.js';
import { useEffect } from 'react';

/** Logged-out front door: student path vs shop-owner path. */
export default function Welcome() {
  const navigate = useNavigate();

  useEffect(() => {
    if (getToken('student')) navigate('/home', { replace: true });
  }, [navigate]);

  return (
    <div className="page">
      <div className="welcome-hero">
        <span className="brand" style={{ fontSize: '1.4rem' }}>
          Print<em>Q</em>
        </span>
        <h1 style={{ marginTop: 18 }}>
          Skip the print
          <br />
          shop crowd.
        </h1>
        <p className="dim" style={{ fontSize: '1rem' }}>
          Send your file, pay, and walk in only when it's your turn — no standing in line.
        </p>
      </div>

      <div className="stack" style={{ marginTop: 8 }}>
        <Link to="/login" className="pick">
          <span className="ic">
            <IconPrinter />
          </span>
          <span style={{ flex: 1 }}>
            <strong>I want to print</strong>
            <span>Login with your phone number</span>
          </span>
          <IconChevron className="dim" />
        </Link>

        <Link to="/dashboard/login" className="pick owner">
          <span className="ic">
            <IconStore />
          </span>
          <span style={{ flex: 1 }}>
            <strong>I run a print shop</strong>
            <span>Open the shop dashboard</span>
          </span>
          <IconChevron className="dim" />
        </Link>
      </div>

      <p className="dim" style={{ textAlign: 'center', marginTop: 24 }}>
        Just exploring? <Link to="/s/demo">Try the demo shop →</Link>
      </p>
      <p className="dim" style={{ textAlign: 'center', marginTop: 8 }}>
        <Link to="/shops">Find a shop near you →</Link>
      </p>
    </div>
  );
}
