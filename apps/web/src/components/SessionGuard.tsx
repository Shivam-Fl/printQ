import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { STUDENT_SESSION_EXPIRED_EVENT, STUDENT_SESSION_EXPIRED_MESSAGE } from '../api.js';
import { studentLoginPath } from '../lib/studentReturn.js';

/** Student screens that need a session. Public pages (landing, shop pages, directory) are excluded. */
const PROTECTED = [/^\/home\/?$/, /^\/profile\/?$/, /^\/jobs(\/|$)/, /^\/s\/[^/]+\/file\//];

export function isProtectedStudentPath(pathname: string): boolean {
  return PROTECTED.some((re) => re.test(pathname));
}

/**
 * Listens for the API client's "student session expired" signal (a 401 that
 * silent renewal could not fix) and sends the student to /login with a friendly
 * message. Renders nothing.
 */
export default function SessionGuard() {
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  useEffect(() => {
    const onExpired = () => {
      if (!isProtectedStudentPath(pathname)) return;
      // come back to this page after signing in again
      navigate(studentLoginPath(pathname + search), { replace: true, state: { notice: STUDENT_SESSION_EXPIRED_MESSAGE } });
    };
    window.addEventListener(STUDENT_SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(STUDENT_SESSION_EXPIRED_EVENT, onExpired);
  }, [navigate, pathname, search]);
  return null;
}
