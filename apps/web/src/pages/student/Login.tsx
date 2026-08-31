import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';

export default function Login() {
  const navigate = useNavigate();
  return (
    <main className="auth-page">
      <div className="auth-page-main">
        <Topbar tag="student" />
        <div className="auth-copy">
          <h1>Your print queue,<br />in your pocket.</h1>
          <p>Sign in once to prepare orders remotely, check in on arrival and keep one stable counter code.</p>
        </div>
        <PhoneLogin onDone={() => navigate('/home', { replace: true })} />
      </div>
      <aside className="auth-aside">
        <div className="auth-proof">
          <span className="eyebrow-label">What happens next</span>
          <ol>
            <li><span>1</span><div><strong>Choose a shop</strong><p>Open its link or scan the QR at the counter.</p></div></li>
            <li><span>2</span><div><strong>Send your files</strong><p>Preview, configure and pay from your phone.</p></div></li>
            <li><span>3</span><div><strong>Check in when present</strong><p>Your walk-in position starts only after you reach the shop.</p></div></li>
          </ol>
        </div>
      </aside>
    </main>
  );
}
