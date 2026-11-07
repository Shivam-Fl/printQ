import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import { studentReturnPath } from '../../lib/studentReturn.js';
import PhoneLogin from './PhoneLogin.js';

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const state = useLocation().state as { notice?: string; from?: string } | null;
  const notice = state?.notice;
  // Back to the page that sent the student here (?next= or router state), never off-site.
  const returnTo = studentReturnPath(params.get('next') ?? state?.from);
  return (
    <main className="auth-page">
      <div className="auth-page-main">
        <Topbar tag="student" />
        <div className="auth-copy">
          <h1>Your print queue,<br />in your pocket.</h1>
          <p>Sign in once to send your files from anywhere, then join the line when you reach the shop.</p>
        </div>
        {notice && <p className="auth-notice" role="status">{notice}</p>}
        <PhoneLogin onDone={() => navigate(returnTo, { replace: true })} />
      </div>
      <aside className="auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">What happens next</span>
          <ol>
            <li><span>1</span><div><strong>Choose a shop</strong><p>Open its link or scan the QR at the counter.</p></div></li>
            <li><span>2</span><div><strong>Send your files</strong><p>Preview and configure on your phone. Pay at the shop.</p></div></li>
            <li><span>3</span><div><strong>Check in when present</strong><p>Your walk-in position starts only after you reach the shop.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
