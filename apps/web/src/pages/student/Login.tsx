import { useNavigate } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import PhoneLogin from './PhoneLogin.js';

/** Full-page student login (from Welcome). Inline login still lives on the shop landing. */
export default function Login() {
  const navigate = useNavigate();
  return (
    <div className="page">
      <Topbar tag="skip the line" />
      <h1>Welcome</h1>
      <p className="dim">Login to send prints and track your queue.</p>
      <PhoneLogin onDone={() => navigate('/home', { replace: true })} />
    </div>
  );
}
